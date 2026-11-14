// Without a model key the agent still listens, talks and sketches for everyday commands:
// the rule parser reads the words, and "here" still means the person's latest sketch.
import { parseSpoken, type SpokenCommand } from '../voice/parse';
import type { Action, AgentReply } from './actions';
import { refersToSketch } from './deixis';

const WALL_WORD: Record<string, string> = { north: 'north', south: 'south', east: 'east', west: 'west', window: 'window', door: 'door' };

function place(cmd: SpokenCommand | null, text: string, hasSketch: boolean): string | undefined {
  if (hasSketch && refersToSketch(text)) return 'here';
  return cmd?.wall ? WALL_WORD[cmd.wall] : undefined;
}

/** Rule-based reply for one utterance. `hasSketch`: the person has drawn something recently. */
export function offlineReply(text: string, hasSketch: boolean, inRoom: (category: string) => boolean = () => false): AgentReply {
  const t = text.toLowerCase().trim();
  const reply = (say: string, actions: Action[] = []): AgentReply => ({ say, sketch: [], actions });

  if (!t) return reply('');
  if (/\b(undo|ångra|take that back)\b/.test(t)) return reply('Undone.', [{ type: 'undo' }]);
  if (/\b(walk|walkthrough|walk through|first person)\b/.test(t) && /\b(show|let|go|start|view|me)\b/.test(t)) return reply('Walking you through it.', [{ type: 'set_view', view: 'walk' }]);
  const view = t.match(/\b(2d|3d|two d|three d|plan view|split)\b/);
  if (view && /\b(show|switch|go|view|see)\b/.test(t)) {
    const v = /3d|three/.test(view[1]) ? '3d' : /split/.test(view[1]) ? 'split' : '2d';
    return reply(`Switching to ${v === 'split' ? 'split' : v.toUpperCase()} view.`, [{ type: 'set_view', view: v }]);
  }
  if (/\b(wall|vägg)\b/.test(t) && hasSketch && refersToSketch(t) && /\b(put|add|build|place|make|want|a|new)\b/.test(t)) {
    return reply('Adding a wall along your line.', [{ type: 'add_wall', from: 'here' }]);
  }
  if (/\b(how (far|long|wide|big)|measure|distance|mät)\b/.test(t)) return reply('', [{ type: 'measure' }]);
  if (/\b(safe|safety|hazard|danger|childproof|fire)\b/.test(t)) return reply('Let me check.', [{ type: 'check_safety' }]);
  if (/\b(why|varför|explain)\b/.test(t)) {
    const topic = /price|cost|expensive|cheap|pris/.test(t) ? 'price' : /face|facing|direction|turned/.test(t) ? 'direction' : 'layout';
    const id = /\b(this|that|it)\b/.test(t) ? 'selected' : undefined;
    return reply('', [{ type: 'explain', topic, id }]);
  }
  if (/\b(find|buy|shop|where can i get|search for)\b/.test(t)) {
    const q = t.replace(/^.*?\b(find|buy|shop for|shop|where can i get|search for)\b\s*(me\s+)?(a|an|some)?\s*/, '').replace(/[?.!]+$/, '');
    return reply('Searching.', [{ type: 'find_products', query: q || t }]);
  }
  if (/\b(design|furnish|plan|lay ?out|arrange|inred)\b/.test(t) && /\b(room|office|space|bedroom|living|kitchen|it|this|for|with|me)\b/.test(t)) {
    return reply('Designing it now.', [{ type: 'design_room', brief: text }]);
  }
  if (/\b(apply|use|go with|pick) (this|that|it|the (first|best)|option|layout)\b/.test(t)) return reply('Applied.', [{ type: 'apply_layout' }]);

  const cmd = parseSpoken(text);
  const hasHere = hasSketch && refersToSketch(t);
  if (!cmd) {
    if (/\b(make|create|build|design me|i want|add)\b/.test(t) && t.split(/\s+/).length >= 3) {
      return reply('Making that for you.', [{ type: 'create_object', prompt: text, place: hasHere ? 'here' : undefined }]);
    }
    return reply(hasSketch ? 'Tell me what goes there, like "put the desk here".' : 'Try "add a desk by the window" or draw where something should go.');
  }
  const what = cmd.category || 'it';
  const where = place(cmd, t, hasSketch);
  const whereWords = where === 'here' ? 'here' : where ? `by the ${where === 'window' || where === 'door' ? where : `${where} wall`}` : '';
  switch (cmd.action) {
    case 'undo': return reply('Undone.', [{ type: 'undo' }]);
    case 'add': {
      // "Put the sofa here" with a sofa already in the room means move it, not add another.
      if (where && inRoom(what) && /\b(put|place|the)\b/.test(t) && !/\b(another|new|second|more|add)\b/.test(t)) {
        return reply(`Moving the ${what} ${whereWords}.`, [{ type: 'move', id: what, place: where }]);
      }
      const actions: Action[] = Array.from({ length: Math.min(cmd.qty, 8) }, () => ({
        type: 'add_catalog', catalogId: cmd.catalogId, place: where, w: cmd.w, d: cmd.d, h: cmd.h, color: cmd.color,
      } as Action));
      return reply(`Adding ${cmd.qty > 1 ? `${cmd.qty} ${what}s` : `a ${what}`}${whereWords ? ` ${whereWords}` : ''}.`, actions);
    }
    case 'move':
      if (!where) return reply(`Where should the ${what} go? You can draw it.`);
      return reply(`Moving the ${what} ${whereWords}.`, [{ type: 'move', id: what, place: where }]);
    case 'rotate': return reply(`Turning the ${what}.`, [{ type: 'rotate', id: what, angle: 90 }]);
    case 'delete': return reply(`Removing the ${what}.`, [{ type: 'remove', id: what }]);
    case 'resize':
      if (hasHere) return reply(`Moving the ${what} here.`, [{ type: 'move', id: what, place: 'here' }]);
      return reply(`Resizing the ${what}.`, [{ type: 'resize', id: what, w: cmd.w, d: cmd.d, h: cmd.h, color: cmd.color }]);
  }
}
