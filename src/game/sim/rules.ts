/**
 * Real-football rules helpers — pure functions shared by the HOST (authority)
 * and the local client (prediction / UI hints). The Game orchestrates.
 *
 * Covered: out of play (touchline + goal line), throw-ins, corners, goal
 * kicks, direct free kicks, penalties, offside (flag-on-touch), and the
 * geometric placement / exclusion zones for each restart.
 */
import { BALL, GOAL, PITCH, RULES } from '../core/constants'
import { clamp } from '../core/math'
import type { RestartKind, Team } from '../core/types'

/** Team A attacks +X (defends x = -halfL). Team B attacks -X. */
export function attackDir(team: Team): 1 | -1 {
  return team === 'A' ? 1 : -1
}

/** The x of the goal a team attacks. */
export function attackedGoalX(team: Team): number {
  return attackDir(team) * PITCH.halfL
}

/** The x of the goal a team defends. */
export function defendedGoalX(team: Team): number {
  return -attackDir(team) * PITCH.halfL
}

export function otherTeam(team: Team): Team {
  return team === 'A' ? 'B' : 'A'
}

export interface PlayerRef {
  id: string
  team: Team
  x: number
  z: number
}

export interface BallRef {
  x: number
  y: number
  z: number
  lastTouch: string | null
}

export type OutResult =
  | { kind: 'throwin'; team: Team; x: number; z: number }
  | { kind: 'corner'; team: Team; x: number; z: number }
  | { kind: 'goalkick'; team: Team; x: number; z: number }
  | null

/**
 * Out-of-play detection, host tick. The pitch boundary is the painted line —
 * the low wall sits 4.5 m beyond it, so the ball can visibly cross the line
 * before the whistle. A goal is handled elsewhere (before this runs).
 */
export function checkOutOfPlay(ball: BallRef, players: readonly PlayerRef[], teams: Record<string, Team>): OutResult {
  const r = BALL.r + RULES.outGrace
  const touchTeam = ball.lastTouch !== null ? (teams[ball.lastTouch] ?? null) : null

  // touchlines (long sides)
  if (Math.abs(ball.z) > PITCH.halfW + r) {
    const team = touchTeam ? otherTeam(touchTeam) : 'A'
    return {
      kind: 'throwin',
      team,
      x: clamp(ball.x, -PITCH.halfL + PITCH.cornerR, PITCH.halfL - PITCH.cornerR),
      z: Math.sign(ball.z) * (PITCH.halfW + RULES.throwStandOff),
    }
  }

  // goal lines (short ends), outside the goal mouth
  const inMouth = Math.abs(ball.z) < GOAL.halfW && ball.y < GOAL.height + 0.1
  if (Math.abs(ball.x) > PITCH.halfL + r && !inMouth) {
    const side: 1 | -1 = ball.x > 0 ? 1 : -1 // goal line crossed
    // The team defending this line:
    const defTeam: Team = side === 1 ? 'B' : 'A'
    if (touchTeam === defTeam) {
      // defender touched it last -> corner for the attackers
      return {
        kind: 'corner',
        team: otherTeam(defTeam),
        x: side * (PITCH.halfL - 0.35),
        z: (ball.z > 0 ? 1 : -1) * (PITCH.halfW - 0.35),
      }
    }
    // attacker touched it last -> goal kick for the defenders
    return {
      kind: 'goalkick',
      team: defTeam,
      x: side * (PITCH.halfL - RULES.goalAreaDepth - 0.2),
      z: clamp(ball.z, -RULES.goalAreaHalfW + 1, RULES.goalAreaHalfW - 1),
    }
  }
  void players
  return null
}

/** True if (x, z) is inside the penalty area that boxes the goal at `goalX`. */
export function inPenaltyBox(x: number, z: number, goalX: number): boolean {
  const depth = RULES.boxDepth
  const inside = goalX > 0 ? x > PITCH.halfL - depth : x < -PITCH.halfL + depth
  return inside && Math.abs(z) < RULES.boxHalfW
}

/** Penalty spot for the goal at `goalX`. */
export function penaltySpot(goalX: number): { x: number; z: number } {
  return { x: goalX > 0 ? PITCH.halfL - RULES.penaltySpot : -PITCH.halfL + RULES.penaltySpot, z: 0 }
}

/**
 * Offside: which players of `team` are in an offside POSITION at the moment
 * the ball is played? (Flag-on-touch is applied by the Game when one of them
 * next touches the ball.)
 */
export function offsidePositions(
  team: Team,
  ballX: number,
  players: readonly PlayerRef[],
): Set<string> {
  const dir = attackDir(team)
  const opp = players.filter((p) => p.team !== team)
  // defenders sorted by depth (closest to their own goal line first)
  const defenders = [...opp].sort((a, b) => (b.x - a.x) * dir)
  // second-last opponent counting from the goal line; goal line itself if fewer
  const secondLastX = defenders.length >= 2 ? defenders[1].x : dir * PITCH.halfL
  const flags = new Set<string>()
  for (const p of players) {
    if (p.team !== team) continue
    const inOppHalf = p.x * dir > RULES.offsideTolerance
    const aheadOfBall = (p.x - ballX) * dir > RULES.offsideTolerance
    const aheadOfDefenders = (p.x - secondLastX) * dir > RULES.offsideTolerance
    if (inOppHalf && aheadOfBall && aheadOfDefenders) flags.add(p.id)
  }
  return flags
}

/** Human label for a restart kind. */
export const RESTART_LABEL: Record<RestartKind, string> = {
  throwin: 'Throw-in',
  corner: 'Corner kick',
  goalkick: 'Goal kick',
  freekick: 'Free kick',
  penalty: 'Penalty!',
  kickoff: 'Kick-off',
}

/**
 * Per-player placement for a restart. The taker goes on the spot; everyone
 * else is pushed out of the exclusion zone (opponents only for corners /
 * free kicks / throw-ins; everyone outside the box for penalties).
 */
export function restartSlots(
  kind: RestartKind,
  team: Team,
  spotX: number,
  spotZ: number,
  takerId: string | null,
  players: readonly PlayerRef[],
): Record<string, [number, number, number]> {
  const slots: Record<string, [number, number, number]> = {}
  const faceCenter = Math.atan2(-(0 - spotX), -(0 - spotZ))
  if (takerId) slots[takerId] = [spotX, spotZ, faceCenter]

  if (kind === 'throwin') {
    for (const p of players) {
      if (p.id === takerId) continue
      // opponents keep clear of the thrower
      const d = Math.hypot(p.x - spotX, p.z - spotZ)
      if (d < 2.4) {
        const k = d < 1e-3 ? 1 : (2.4 - d) + 0.1
        const ux = d < 1e-3 ? 0 : (p.x - spotX) / d
        const uz = d < 1e-3 ? 1 : (p.z - spotZ) / d
        slots[p.id] = [clamp(p.x + ux * k, -PITCH.halfL + 1, PITCH.halfL - 1), clamp(p.z + uz * k, -PITCH.halfW + 0.5, PITCH.halfW - 0.5), p.x === spotX ? faceCenter : Math.atan2(-(spotX - p.x), -(spotZ - p.z))]
      }
    }
    return slots
  }

  if (kind === 'penalty') {
    const goalX = spotX > 0 ? PITCH.halfL : -PITCH.halfL
    for (const p of players) {
      if (p.id === takerId) continue
      let { x, z } = p
      if (inPenaltyBox(x, z, goalX)) {
        // push to the nearest edge outside the box, behind the spot
        const behindX = spotX - Math.sign(spotX) * 1.2
        const outX = goalX > 0 ? Math.min(behindX, PITCH.halfL - RULES.boxDepth - 0.4) : Math.max(behindX, -PITCH.halfL + RULES.boxDepth + 0.4)
        const dzBox = Math.abs(z) >= RULES.boxHalfW - 0.3 ? z : Math.sign(z || 1) * (RULES.boxHalfW + 0.4)
        // nearest of the two escapes
        const dxOut = Math.abs(outX - x)
        const dzOut = Math.hypot(dzBox - z, 0)
        if (dxOut <= dzOut) x = outX
        else z = dzBox
        x = clamp(x, -PITCH.halfL + 0.8, PITCH.halfL - 0.8)
        z = clamp(z, -PITCH.halfW + 0.5, PITCH.halfW - 0.5)
      }
      slots[p.id] = [x, z, Math.atan2(-(spotX - x), -(spotZ - z))]
    }
    return slots
  }

  if (kind === 'corner' || kind === 'freekick') {
    const rad = RULES.freeKickRadius
    for (const p of players) {
      if (p.id === takerId) continue
      // only the team NOT awarded the restart must keep distance
      if (p.team === team) continue
      const d = Math.hypot(p.x - spotX, p.z - spotZ)
      if (d < rad) {
        const ux = d < 1e-3 ? 0 : (p.x - spotX) / d
        const uz = d < 1e-3 ? 1 : (p.z - spotZ) / d
        const push = rad - d + 0.15
        slots[p.id] = [clamp(p.x + ux * push, -PITCH.halfL + 0.6, PITCH.halfL - 0.6), clamp(p.z + uz * push, -PITCH.halfW + 0.4, PITCH.halfW - 0.4), Math.atan2(-(spotX - p.x), -(spotZ - p.z))]
      }
    }
    return slots
  }

  // goal kick: nobody needs moving
  return slots
}
