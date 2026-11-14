import { describe, expect, it } from 'vitest';
import { parseSpoken, validate } from './parse';

describe('parseSpoken', () => {
  it('adds a sofa with exact dims and colour', () => {
    expect(parseSpoken('add a grey sofa 210 wide 95 deep')).toMatchObject({ action: 'add', category: 'sofa', qty: 1, w: 2.1, d: 0.95, color: 'grey' });
  });
  it('handles metres, "by" and the window wall', () => {
    expect(parseSpoken('put a desk 1.6 metres by 80 against the window wall')).toMatchObject({ action: 'add', category: 'desk', w: 1.6, d: 0.8, wall: 'window' });
  });
  it('reads number words as quantity', () => {
    expect(parseSpoken('add two chairs')).toMatchObject({ action: 'add', category: 'chair', qty: 2 });
    expect(parseSpoken('add 3 chairs')).toMatchObject({ qty: 3 });
  });
  it('resize, move, rotate, delete, undo', () => {
    expect(parseSpoken('make the bed 160')).toMatchObject({ action: 'resize', category: 'bed', w: 1.6 });
    expect(parseSpoken('move the sofa to the left wall')).toMatchObject({ action: 'move', category: 'sofa', wall: 'west' });
    expect(parseSpoken('rotate the desk')).toMatchObject({ action: 'rotate', category: 'desk' });
    expect(parseSpoken('delete the rug')).toMatchObject({ action: 'delete', category: 'rug' });
    expect(parseSpoken('Undo.')).toEqual({ action: 'undo', category: '', qty: 1 });
  });
  it('supports mm, 120x60 and Swedish basics', () => {
    expect(parseSpoken('lägg till en soffa 2000 mm bred')).toMatchObject({ action: 'add', category: 'sofa', w: 2 });
    expect(parseSpoken('lägg till två stolar')).toMatchObject({ category: 'chair', qty: 2 });
    expect(parseSpoken('ta bort skrivbordet')).toMatchObject({ action: 'delete', category: 'desk' });
    expect(parseSpoken('add a desk 120x60cm')).toMatchObject({ w: 1.2, d: 0.6 });
  });
  it('drops out-of-range dims and unknown items', () => {
    expect(parseSpoken('add a sofa 900 wide')?.w).toBeUndefined();
    expect(parseSpoken('add a spaceship')).toBeNull();
    expect(validate({ action: 'add', category: 'sofa', qty: 1, w: 0.1 })?.w).toBeUndefined();
  });
});
