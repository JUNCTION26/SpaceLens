// Follow-ups on a themed room: "add a second poster that says GOOD BOY", "make the bed bigger",
// "remove the clock". Pieces that did not change are reused as they are, so only the new or
// changed ones are built and the room is laid out again in well under a second.
import type { SpaceModel } from '../../core/types';
import { fitSpec } from '../forge/fit';
import { WALL_RECIPES, type Recipe, type ThemeBrief, type ThemeObject } from './brief';
import { designThemedRoom, objectKey, type ThemedOpts, type ThemedResult } from './designThemed';
import { RECIPE_SIZE_CM } from './recipes';

const DECOR_WORDS: Array<[RegExp, Recipe]> = [
  [/neon/, 'neon'], [/poster|picture|print|frame/, 'poster'], [/sign|plaque/, 'sign'], [/banner|flag|pennant/, 'banner'],
  [/clock/, 'clock'], [/shelf/, 'wallshelf'], [/statue|sculpture|figure/, 'statue'], [/cat tree|cat tower/, 'cat-tree'],
  [/scratch/, 'scratching-post'], [/litter/, 'litter-box'], [/bowl/, 'pet-bowls'], [/toy basket|basket/, 'toy-basket'], [/perch/, 'window-perch'], [/vanity/, 'vanity'],
];

export interface ThemeEdit { brief: ThemeBrief; changed: string[]; reply: string }

/** Apply one follow-up to a brief. Returns the new brief, the keys of changed objects and a reply. */
export function editBrief(brief: ThemeBrief, ask: string): ThemeEdit {
  const t = ask.trim(), lc = t.toLowerCase();
  const objects = brief.objects.map((o) => ({ ...o }));
  const changed: string[] = [];
  const said: string[] = [];
  const findObj = (words: string) => {
    const w = words.toLowerCase().replace(/^(the|my|a|an)\s+/, '').trim();
    return objects.find((o) => o.name.toLowerCase() === w) ?? objects.find((o) => o.name.toLowerCase().includes(w)) ?? objects.find((o) => w.split(/\s+/).some((x) => x.length > 2 && o.name.toLowerCase().includes(x)));
  };
  const add = t.match(/\b(?:add|put|hang|include)\b\s+(?:a |an |another |a second |one more |some )?(.+)$/i);
  const resize = lc.match(/\bmake\s+(?:the\s+)?(.+?)\s+(bigger|larger|smaller|wider|narrower|taller|shorter|longer)\b/);
  const remove = lc.match(/\b(?:remove|drop|delete|no more|get rid of)\s+(?:the\s+)?(.+?)$/);
  if (resize) {
    const o = findObj(resize[1]);
    if (o) {
      const k = /bigger|larger|wider|taller|longer/.test(resize[2]) ? 1.25 : 0.8;
      const base = o.sizeCm ?? (o.recipe ? RECIPE_SIZE_CM[o.recipe] : undefined);
      if (base) {
        const axis = /wider|narrower/.test(resize[2]) ? [0] : /taller|shorter/.test(resize[2]) ? [2] : /longer/.test(resize[2]) ? [1] : o.mount === 'wall' ? [0, 2] : [0, 1];
        o.sizeCm = base.map((v, i) => (axis.includes(i) ? Math.round(v * k) : v)) as [number, number, number];
        if (o.prompt) o.prompt = o.prompt.replace(/\d+(\.\d+)? x \d+(\.\d+)? x \d+(\.\d+)? cm/, `${o.sizeCm[0]} x ${o.sizeCm[1]} x ${o.sizeCm[2]} cm`);
        if (o.source !== 'custom') { o.source = 'custom'; o.prompt = `${o.name}, ${o.sizeCm[0]} x ${o.sizeCm[1]} x ${o.sizeCm[2]} cm, ${brief.title}`; }
        changed.push(o.name.toLowerCase());
        said.push(`${o.name} ${k > 1 ? 'bigger' : 'smaller'}`);
      }
    }
  } else if (remove && !add) {
    const o = findObj(remove[1]);
    if (o) { objects.splice(objects.indexOf(o), 1); said.push(`removed ${o.name}`); }
  } else if (add) {
    const rest = add[1].replace(/[.!]+$/, '');
    const words = rest.match(/\b(?:that says|saying|which says|reading|with the (?:name|words?)|with the text|that reads|with)\s+["“']?(.+?)["”']?$/i);
    const what = (words ? rest.slice(0, words.index).trim() : rest).toLowerCase();
    const recipe = DECOR_WORDS.find(([re]) => re.test(what))?.[1];
    const text = words?.[1]?.trim();
    const like = objects.find((o) => o.recipe === recipe);
    const n = objects.filter((o) => o.recipe && o.recipe === recipe).length;
    const name = text ? `${text} ${what.replace(/^second |^another /, '')}`.slice(0, 50) : `${what.replace(/^second |^another /, '')}${n ? ` ${n + 1}` : ''}`;
    const o: ThemeObject = {
      source: 'custom', name: name.charAt(0).toUpperCase() + name.slice(1), recipe, text, mount: recipe && WALL_RECIPES.has(recipe) ? 'wall' : 'floor',
      style: like?.style, color: like?.color ?? brief.palette[2] ?? brief.palette[0], accent: like?.accent ?? brief.palette[1],
      prompt: `${what}, in the ${brief.title} palette ${brief.palette.join(' ')}${text ? `, with the words "${text}" printed on the front` : ''}`,
    };
    objects.push(o);
    said.push(text ? `added a ${what.replace(/^second |^another /, '')} that says ${text}` : `added ${what}`);
  }
  return { brief: { ...brief, objects }, changed, reply: said.length ? `Changed: ${said.join(', ')}.` : 'Could not read that. Try "add a poster that says HELLO" or "make the bed bigger".' };
}

/** A themed room after one follow-up, reusing every piece that did not change. */
export async function refineThemed(model: SpaceModel, prev: ThemedResult, ask: string, opts: ThemedOpts = {}): Promise<ThemedResult & { reply: string }> {
  const edit = editBrief(prev.brief, ask);
  const reuse = new Map(prev.specs);
  for (const o of edit.brief.objects) {
    if (!edit.changed.includes(o.name.toLowerCase())) continue;
    for (let k = 0; k < Math.max(1, o.qty ?? 1); k++) {
      const key = objectKey(o, k), old = reuse.get(key);
      // A model-made piece keeps its look at the new size; a code-built one is rebuilt.
      if (old && old.model !== 'rules' && o.sizeCm) reuse.set(key, fitSpec(old, { w: o.sizeCm[0] / 100, d: o.sizeCm[1] / 100, h: o.sizeCm[2] / 100 }));
      else reuse.delete(key);
    }
  }
  const res = await designThemedRoom(model, ask, { ...opts, brief: edit.brief, reuse });
  return { ...res, reply: edit.reply };
}
