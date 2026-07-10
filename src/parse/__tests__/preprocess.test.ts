import { describe, expect, it } from 'vitest'
import { preprocess } from '../preprocess.js'

describe('T-AC-2-5: REQ-ID stripping + unicode/whitespace/punct preprocessing', () => {
  describe('REQ-ID stripping (various formats)', () => {
    it('REQ-042: format', () => {
      expect(preprocess('REQ-042: the system shall log')).toBe('the system shall log')
    })

    it('REQ_042 format (underscore)', () => {
      expect(preprocess('REQ_042 the system shall log')).toBe('the system shall log')
    })

    it('SYS-12. format (letter prefix)', () => {
      expect(preprocess('SYS-12. the system shall boot')).toBe('the system shall boot')
    })

    it('3.1.4) format (dot-delimited)', () => {
      expect(preprocess('3.1.4) the system shall respond')).toBe('the system shall respond')
    })

    it('3.1 format (partial dot-delimited)', () => {
      expect(preprocess('3.1: the system shall execute')).toBe('the system shall execute')
    })

    it('no ID prefix leaves input intact', () => {
      expect(preprocess('the system shall log events')).toBe('the system shall log events')
    })
  })

  describe('Whitespace normalization', () => {
    it('multiple spaces collapsed to single space', () => {
      expect(preprocess('the   system   shall   log')).toBe('the system shall log')
    })

    it('leading/trailing whitespace trimmed', () => {
      expect(preprocess('  the system shall log  ')).toBe('the system shall log')
    })

    it('mixed whitespace (tabs, newlines) normalized', () => {
      expect(preprocess('the\t\nsystem\r\nshall\tlog')).toBe('the system shall log')
    })
  })

  describe('Trailing punctuation removal', () => {
    it('trailing period removed', () => {
      expect(preprocess('the system shall log.')).toBe('the system shall log')
    })

    it('trailing semicolon removed', () => {
      expect(preprocess('the system shall log;')).toBe('the system shall log')
    })

    it('trailing period with whitespace', () => {
      expect(preprocess('the system shall log . ')).toBe('the system shall log')
    })

    it('internal punctuation preserved', () => {
      expect(preprocess('the API shall return a 404.')).toBe('the API shall return a 404')
    })

    it('commas not removed (only . and ;)', () => {
      expect(preprocess('the system shall accept a, b, c')).toBe('the system shall accept a, b, c')
    })
  })

  describe('Combined transformations (full workflow)', () => {
    it('REQ-ID + whitespace + trailing punct', () => {
      expect(preprocess('REQ-042:  The  system shall log events.')).toBe(
        'The system shall log events',
      )
    })

    it('all ID patterns covered', () => {
      const cases = [
        ['REQ-123: foo', 'foo'],
        ['3.1.4) foo', 'foo'],
        ['SYS-12. foo', 'foo'],
        ['3.1: foo', 'foo'],
      ]
      for (const [input, expected] of cases) {
        expect(preprocess(input)).toBe(expected)
      }
    })

    it('multiple transformations applied in sequence', () => {
      const input = '  REQ-042:   The   system   shall   log  .  '
      const result = preprocess(input)
      expect(result).toBe('The system shall log')
    })
  })

  describe('Edge cases', () => {
    it('empty string → empty string', () => {
      expect(preprocess('')).toBe('')
    })

    it('only whitespace → empty string', () => {
      expect(preprocess('   \t\n   ')).toBe('')
    })

    it('only ID → empty string', () => {
      expect(preprocess('REQ-123:')).toBe('')
    })

    it('ID with only trailing punct → empty string', () => {
      expect(preprocess('REQ-123:.')).toBe('')
    })

    it('period in the middle preserved (not trailing)', () => {
      expect(preprocess('the API returns a 404.0 response.')).toBe(
        'the API returns a 404.0 response',
      )
    })
  })
})
