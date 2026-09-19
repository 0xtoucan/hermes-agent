import { describe, expect, it } from 'vitest'

import { createWindowOpenHandler, shouldDenyFrameNavigation } from './window-open-policy'

describe('createWindowOpenHandler', () => {
  it('denies unconditionally and reports only the origin', () => {
    const seen: string[] = []
    const handler = createWindowOpenHandler(origin => void seen.push(origin))

    expect(handler({ url: 'https://attacker.example/steal?token=abc' })).toEqual({ action: 'deny' })
    expect(seen).toEqual(['https://attacker.example'])
  })
})

describe('shouldDenyFrameNavigation (srcdoc sandbox egress)', () => {
  const fromSrcdoc = (url: string) => shouldDenyFrameNavigation({ frameUrl: 'about:srcdoc', isMainFrame: false, url })

  it('blocks a srcdoc frame navigating itself anywhere but back to srcdoc', () => {
    expect(fromSrcdoc('https://attacker.example/?d=exfil')).toBe(true)
    expect(fromSrcdoc('http://attacker.example/')).toBe(true)
    expect(fromSrcdoc('about:blank')).toBe(true)
    expect(fromSrcdoc('data:text/html,hi')).toBe(true)
    expect(fromSrcdoc('file:///etc/passwd')).toBe(true)
  })

  it('allows the srcdoc (re)load itself, from about:blank and from srcdoc', () => {
    expect(fromSrcdoc('about:srcdoc')).toBe(false)
    expect(shouldDenyFrameNavigation({ frameUrl: 'about:blank', isMainFrame: false, url: 'about:srcdoc' })).toBe(false)
  })

  it('leaves the main frame and ordinary remote embeds alone', () => {
    expect(
      shouldDenyFrameNavigation({ frameUrl: 'file:///app/index.html', isMainFrame: true, url: 'https://x/' })
    ).toBe(false)
    expect(
      shouldDenyFrameNavigation({
        frameUrl: 'https://www.youtube.com/embed/a',
        isMainFrame: false,
        url: 'https://www.youtube.com/embed/b'
      })
    ).toBe(false)
  })
})
