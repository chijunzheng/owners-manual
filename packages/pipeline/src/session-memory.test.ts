import { describe, expect, it } from 'vitest'

import {
  SESSION_SUMMARY_MAX_CHARS,
  appendTurn,
  emptySessionMemory,
  parseSessionMemory,
  renderSessionMemoryContext,
  type SessionMemory,
  type SessionSummarizer,
} from './session-memory.js'

/** A deterministic, offline summarizer: it concatenates and hard-truncates. */
const naiveSummarizer: SessionSummarizer = async ({ priorSummary, question, answer }) => {
  const merged = `${priorSummary} Q:${question} A:${answer}`.trim()
  return merged
}

describe('parseSessionMemory', () => {
  it('validates a session keyed by session id with a bounded summary', () => {
    const memory = parseSessionMemory({
      sessionId: 'sess-synthetic-1',
      summary: 'The owner asked who repairs the unit.',
      turnCount: 1,
    })
    expect(memory.sessionId).toBe('sess-synthetic-1')
    expect(memory.turnCount).toBe(1)
  })

  it('rejects a session with no session id', () => {
    expect(() => parseSessionMemory({ sessionId: '', summary: '', turnCount: 0 })).toThrow()
  })

  it('rejects a summary over the bound (the schema enforces the cap)', () => {
    expect(() =>
      parseSessionMemory({
        sessionId: 's',
        summary: 'x'.repeat(SESSION_SUMMARY_MAX_CHARS + 1),
        turnCount: 1,
      }),
    ).toThrow()
  })

  it('rejects a negative turn count', () => {
    expect(() => parseSessionMemory({ sessionId: 's', summary: '', turnCount: -1 })).toThrow()
  })
})

describe('emptySessionMemory', () => {
  it('starts a fresh session with an empty summary and zero turns', () => {
    const memory = emptySessionMemory('sess-new')
    expect(memory.summary).toBe('')
    expect(memory.turnCount).toBe(0)
  })
})

describe('appendTurn — bounded summarization (AC2)', () => {
  it('summarizes one turn into the rolling summary and bumps the turn count', async () => {
    const memory = await appendTurn(emptySessionMemory('s'), {
      question: 'who repairs the unit?',
      answer: 'The landlord must keep the unit in repair.',
      summarize: naiveSummarizer,
    })
    expect(memory.turnCount).toBe(1)
    expect(memory.summary).toContain('who repairs the unit?')
  })

  it('keeps the summary BOUNDED across many turns — it is summarization, not transcript growth', async () => {
    let memory: SessionMemory = emptySessionMemory('s')
    // A summarizer that would, unbounded, append the full text of every turn.
    const growing: SessionSummarizer = async ({ priorSummary, question, answer }) =>
      `${priorSummary} ${question} ${answer}`
    for (let i = 0; i < 200; i += 1) {
      memory = await appendTurn(memory, {
        question: `question number ${i} about the condo declaration and bylaws`,
        answer: `answer number ${i} citing several sections of the governing documents`,
        summarize: growing,
      })
    }
    // The defining property: the stored summary never exceeds the cap, no matter
    // how many turns accumulate — so memory cost is bounded, not linear in turns.
    expect(memory.summary.length).toBeLessThanOrEqual(SESSION_SUMMARY_MAX_CHARS)
    expect(memory.turnCount).toBe(200)
  })

  it('re-validates the summarizer output so a too-long summary cannot be persisted', async () => {
    const overlong: SessionSummarizer = async () => 'y'.repeat(SESSION_SUMMARY_MAX_CHARS + 500)
    const memory = await appendTurn(emptySessionMemory('s'), {
      question: 'q',
      answer: 'a',
      summarize: overlong,
    })
    expect(memory.summary.length).toBeLessThanOrEqual(SESSION_SUMMARY_MAX_CHARS)
  })

  it('returns a NEW memory object (immutability) — never mutates the input', async () => {
    const before = emptySessionMemory('s')
    const after = await appendTurn(before, {
      question: 'q',
      answer: 'a',
      summarize: naiveSummarizer,
    })
    expect(after).not.toBe(before)
    expect(before.turnCount).toBe(0)
    expect(before.summary).toBe('')
  })
})

describe('renderSessionMemoryContext', () => {
  it('renders the rolling summary as a labelled prompt block', () => {
    const block = renderSessionMemoryContext({
      sessionId: 's',
      summary: 'Earlier the owner asked about the master insurance policy.',
      turnCount: 2,
    })
    expect(block).toContain('master insurance policy')
    expect(block).toMatch(/conversation|earlier|so far/i)
  })

  it('renders nothing for an absent session (the off-state fallback)', () => {
    expect(renderSessionMemoryContext(undefined)).toBe('')
  })

  it('renders nothing for a fresh session with no summary yet', () => {
    expect(renderSessionMemoryContext(emptySessionMemory('s'))).toBe('')
  })
})
