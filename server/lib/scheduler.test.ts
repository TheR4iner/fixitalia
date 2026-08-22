import { describe, expect, it } from 'vitest'

import { isFireDue, wallClockIn } from './scheduler.ts'

describe('wallClockIn', () => {
  it('renders the wall-clock date and time in the requested IANA zone', () => {
    // 2026-05-04 04:00 UTC == 2026-05-04 06:00 Europe/Rome (DST in May)
    const utc = new Date('2026-05-04T04:00:00Z')
    expect(wallClockIn('Europe/Rome', utc)).toEqual({
      date: '2026-05-04',
      time: '06:00',
    })
  })

  it('respects DST: same UTC instant is +1h in winter, +2h in summer', () => {
    const winter = new Date('2026-01-15T05:00:00Z')
    expect(wallClockIn('Europe/Rome', winter)).toEqual({
      date: '2026-01-15',
      time: '06:00',
    })
    const summer = new Date('2026-07-15T04:00:00Z')
    expect(wallClockIn('Europe/Rome', summer)).toEqual({
      date: '2026-07-15',
      time: '06:00',
    })
  })

  it('honors UTC when asked', () => {
    const utc = new Date('2026-05-04T13:37:00Z')
    expect(wallClockIn('UTC', utc)).toEqual({
      date: '2026-05-04',
      time: '13:37',
    })
  })
})

describe('isFireDue', () => {
  const cfg = { hour: 6, minute: 0, timezone: 'Europe/Rome' }

  it('fires once we have crossed the target time and have not run today', () => {
    const at0600 = new Date('2026-05-04T04:00:00Z')
    expect(isFireDue(cfg, null, at0600)).toBe(true)
  })

  it('does not fire before the target time', () => {
    const at0559 = new Date('2026-05-04T03:59:00Z')
    expect(isFireDue(cfg, null, at0559)).toBe(false)
  })

  it('does not fire twice on the same day', () => {
    const at0700 = new Date('2026-05-04T05:00:00Z')
    expect(isFireDue(cfg, '2026-05-04', at0700)).toBe(false)
  })

  it('fires on the next day even if previous fire was late', () => {
    const tomorrow0600 = new Date('2026-05-05T04:00:00Z')
    expect(isFireDue(cfg, '2026-05-04', tomorrow0600)).toBe(true)
  })

  it('respects a non-zero target minute', () => {
    const cfg2 = { hour: 6, minute: 30, timezone: 'Europe/Rome' }
    const at0629 = new Date('2026-05-04T04:29:00Z')
    const at0630 = new Date('2026-05-04T04:30:00Z')
    expect(isFireDue(cfg2, null, at0629)).toBe(false)
    expect(isFireDue(cfg2, null, at0630)).toBe(true)
  })
})
