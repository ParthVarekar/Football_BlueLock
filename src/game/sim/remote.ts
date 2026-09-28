/**
 * Remote players: a ~120 ms interpolation buffer over 20 Hz transform
 * broadcasts, with short capped extrapolation. Pure data — rendering rigs are
 * driven from the sampled poses.
 */
import { NET } from '../core/constants'
import { wrapAngle } from '../core/math'
import type { PlayerStateMsg, SampledPose, Team } from '../core/types'

interface RemoteEntry {
  samples: PlayerStateMsg[]
  name: string
  team: Team
}

export class RemotePlayers {
  private map = new Map<string, RemoteEntry>()

  setInfo(id: string, name: string, team: Team): void {
    const e = this.map.get(id)
    if (e) {
      e.name = name
      e.team = team
    } else {
      this.map.set(id, { samples: [], name, team })
    }
  }

  getInfo(id: string): { name: string; team: Team } | null {
    const e = this.map.get(id)
    return e ? { name: e.name, team: e.team } : null
  }

  ids(): string[] {
    return [...this.map.keys()]
  }

  onState(msg: PlayerStateMsg): void {
    const e = this.map.get(msg.id)
    if (!e) return
    const last = e.samples[e.samples.length - 1]
    if (last && msg.seq <= last.seq) return
    e.samples.push(msg)
    while (e.samples.length > 6) e.samples.shift()
  }

  /** Hard-set a remote player's position (kickoff teleport, snapshot). */
  snap(id: string, x: number, z: number, yaw: number): void {
    const e = this.map.get(id)
    if (!e) return
    e.samples.length = 0
    e.samples.push({
      id,
      x,
      z,
      yaw,
      spd: 0,
      spr: 0,
      kickT: 0,
      cutS: 0,
      flickT: 0,
      stepT: 0,
      slideT: 0,
      throwT: 0,
      act: 0,
      actT: 0,
      actS: 0,
      jugl: 0,
      seq: -1,
      t: performance.now() / 1000,
    })
  }

  remove(id: string): void {
    this.map.delete(id)
  }

  clear(): void {
    this.map.clear()
  }

  /** Interpolated pose at `now` minus the buffer delay. */
  sample(id: string, now: number): SampledPose | null {
    const e = this.map.get(id)
    if (!e || e.samples.length === 0) return null
    const renderT = now - NET.interpDelay

    // drop stale samples
    while (e.samples.length > 2 && e.samples[1].t <= renderT - 0.25) e.samples.shift()

    if (e.samples.length === 1) {
      const s = e.samples[0]
      return poseFromMsg(s)
    }

    for (let i = 0; i < e.samples.length - 1; i++) {
      const a = e.samples[i]
      const b = e.samples[i + 1]
      if (a.t <= renderT && renderT <= b.t) {
        const span = Math.max(1e-4, b.t - a.t)
        const t = (renderT - a.t) / span
        return {
          x: a.x + (b.x - a.x) * t,
          z: a.z + (b.z - a.z) * t,
          yaw: a.yaw + wrapAngle(b.yaw - a.yaw) * t,
          spd: a.spd + (b.spd - a.spd) * t,
          spr: b.spr === 1,
          kickT: b.kickT,
          cutS: b.cutS,
          flickT: b.flickT,
          stepT: b.stepT,
          slideT: b.slideT,
          throwT: b.throwT,
          act: b.act,
          actT: b.actT,
          actS: b.actS,
          jugl: b.jugl,
          st: b.st ?? 0,
          stT: b.stT ?? 0,
        }
      }
    }

    // extrapolate from the newest pair, capped
    const a = e.samples[e.samples.length - 2]
    const b = e.samples[e.samples.length - 1]
    const span = Math.max(1e-4, b.t - a.t)
    const t = Math.min(2.5, (renderT - b.t) / span)
    if (t <= 0) return poseFromMsg(b)
    return {
      x: b.x + (b.x - a.x) * t,
      z: b.z + (b.z - a.z) * t,
      yaw: b.yaw + wrapAngle(b.yaw - a.yaw) * t,
      spd: b.spd,
      spr: b.spr === 1,
      kickT: b.kickT,
      cutS: b.cutS,
      flickT: b.flickT,
      stepT: b.stepT,
      slideT: b.slideT,
      throwT: b.throwT,
      act: b.act,
      actT: b.actT,
      actS: b.actS,
      jugl: b.jugl,
      st: b.st ?? 0,
      stT: b.stT ?? 0,
    }
  }

  /** Latest known pose (for collisions, kick validation, dribbler records). */
  latest(id: string): { x: number; z: number; yaw: number } | null {
    const e = this.map.get(id)
    if (!e || e.samples.length === 0) return null
    const s = e.samples[e.samples.length - 1]
    return { x: s.x, z: s.z, yaw: s.yaw }
  }

  /** Latest anim timers (foul detection reads slideT). */
  latestAnims(id: string): { slideT: number; kickT: number } | null {
    const e = this.map.get(id)
    if (!e || e.samples.length === 0) return null
    const s = e.samples[e.samples.length - 1]
    return { slideT: s.slideT, kickT: s.kickT }
  }

  /** Seconds since the last transform arrived (Infinity if never). */
  age(id: string, now: number): number {
    const e = this.map.get(id)
    if (!e || e.samples.length === 0) return Infinity
    const s = e.samples[e.samples.length - 1]
    return s.seq === -1 ? 0 : now - s.t
  }

  /** Latest self-reported super status (sealed / knocked / frozen / cyclone / glide). */
  latestStatus(id: string): { st: number; stT: number } | null {
    const e = this.map.get(id)
    if (!e || e.samples.length === 0) return null
    const s = e.samples[e.samples.length - 1]
    return { st: s.st ?? 0, stT: s.stT ?? 0 }
  }

  /** Latest planar velocity estimate (m/s). */
  latestVel(id: string): { vx: number; vz: number } | null {
    const e = this.map.get(id)
    if (!e || e.samples.length < 2) return null
    const a = e.samples[e.samples.length - 2]
    const b = e.samples[e.samples.length - 1]
    const dt = Math.max(1e-3, b.t - a.t)
    return { vx: (b.x - a.x) / dt, vz: (b.z - a.z) / dt }
  }
}

function poseFromMsg(s: PlayerStateMsg): SampledPose {
  return {
    x: s.x,
    z: s.z,
    yaw: s.yaw,
    spd: s.spd,
    spr: s.spr === 1,
    kickT: s.kickT,
    cutS: s.cutS,
    flickT: s.flickT,
    stepT: s.stepT,
    slideT: s.slideT,
    throwT: s.throwT,
    act: s.act,
    actT: s.actT,
    actS: s.actS,
    jugl: s.jugl,
    st: s.st ?? 0,
    stT: s.stT ?? 0,
  }
}
