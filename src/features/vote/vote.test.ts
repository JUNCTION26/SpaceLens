import { describe, expect, it } from 'vitest';
import { pollIdFromUrl, pollsEnabled, winnerOf, planOf, type Poll } from './api';
import type { SpaceModel } from '../../core/types';

const poll = (votes: number[]): Poll => ({ id: 'abcdefghij', createdAt: 0, expiresAt: 1, total: 0, layouts: votes.map((v) => ({ name: 'L', priceSek: 1, votes: v })) });

describe('vote client', () => {
  it('Share is hidden without an API base', () => {
    expect(pollsEnabled('')).toBe(false);
    expect(pollsEnabled('https://api.example.test')).toBe(true);
  });
  it('reads a poll id from the link and ignores junk', () => {
    expect(pollIdFromUrl('?poll=abcdefghij')).toBe('abcdefghij');
    expect(pollIdFromUrl('?poll=../x')).toBeNull();
    expect(pollIdFromUrl('')).toBeNull();
  });
  it('winner is the clear leader, none on a tie or no votes', () => {
    expect(winnerOf(poll([1, 3, 2]))).toBe(1);
    expect(winnerOf(poll([2, 2]))).toBe(-1);
    expect(winnerOf(poll([0, 0]))).toBe(-1);
  });
  it('plan data is relative to the room corner', () => {
    const m = { spaces: [{ id: 's', polygon: [{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 4 }, { x: 1, y: 4 }] }] } as unknown as SpaceModel;
    const p = planOf(m, [{ x: 2, y: 2, w: 1, d: 1, rotation: 0 } as never]);
    expect(p.w).toBe(4);
    expect(p.h).toBe(3);
    expect(p.items[0]).toMatchObject({ x: 1, y: 1 });
    expect(p.room).toHaveLength(4);
  });
});
