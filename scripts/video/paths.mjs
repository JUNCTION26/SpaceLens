// Where the video pipeline keeps its working files and its output.
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const TEMP = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp') : tmpdir();
export const WORK = process.env.SPACELENS_VIDEO_WORK ?? join(TEMP, 'spacelens-shots', 'video');
export const FRAMES = join(WORK, 'frames');
export const AUDIO = join(WORK, 'audio');
export const CHECK = join(WORK, 'check');
export const OUT = process.env.SPACELENS_VIDEO_OUT ?? join(homedir(), 'Desktop', 'SpaceLens-deck');
// Status line read by other work on the same machine (see capture.mjs).
export const BOARD_STATUS = process.env.SPACELENS_BOARD_STATUS ?? join(TEMP, 'spacelens-shots', 'BOARD', 'video.md');
