# Usage

How to drive SpaceLens. Everything here works on the live site without a key unless it says otherwise.

## The screen

- **Home.** One field ("Describe the space you want"), a microphone and a camera button next to it, and three one-click starts: Plan to 3D (a real apartment), Plan a villa (3 bedrooms), Design a room (home office). "Your own space" folds out the ways in: scan with the phone, photos, import a plan, draw by hand, or continue your last room.
- **Workspace.** The rail on the left has five destinations: Space (Measure, Drawings, Floor), Design (Describe, Layouts, Checks, Style), Furnish (Library, Create, Shop, Budget), Review (Walk, Safety), Share (Export, Move in, Render). Each destination shows its sections as tabs above the panel. The plan and the 3D view fill the rest of the screen, with 2D, Split and 3D switches.
- **In the panel.** Messages appear as one line at the bottom. The Inspector for the selected item sits at the top. Settings (gear on the rail, or press ?) and search (the top-bar field, or Ctrl K) replace the panel content until you leave them. The assistant is pinned at the bottom.

## Resize a room

Three ways, all through the same edit with undo:

1. **Type W, D, H** at the top of Space > Measure. Enter or leaving the field applies it; the arrow keys step by 0.1 m (1 m with Shift). A single field also accepts `5 x 6` or `5 by 6 by 2.7`.
2. **Click a size on the plan** (the dimension chip on a wall) and type the new length.
3. **Say it**: "make the room 5 by 6", "ceiling 2.7", "wider by 1 m", "bigger".

## Eye view

Press the walk button in the 3D view. It starts in the corner farthest from the windows, looking at the middle of the room.

| Input | Does |
| --- | --- |
| W A S D | Move |
| Arrow keys | Look around |
| Drag the mouse | Look around |
| Shift | Walk faster |
| C, Space | Lower, raise the eyes |
| Esc | Leave; the view glides back to the orbit view |

On a phone, the left half of the screen is a stick and the right half looks; Tilt turns the phone to look.

## Sentences that work

In the Describe field (Enter sends, Shift+Enter adds a line) or the assistant:

- `Home office for two, keep my desk, clear route to the window, under 12 000 kr` designs layouts from requirements.
- `make the room 5 by 6` resizes the room.
- `move the sofa to the window`, `add two plants`, `more space` edit the room that is already there. Several clauses apply in order: `add a plant and move the sofa to the window`.
- `add a pink princess bed` generates the piece to size, sketches where it goes, then places it (needs a key).
- `how big is the room`, `how many doors are there`, `hur stor är rummets storlek?` are answered at once from the model. On a whole plan: `which rooms have no window`, `how far is the kitchen from the bathroom`, `what is the longest walk to an exit`.
- `grey 3-seat sofa under 6 000 kr, max 220 cm wide` in Shop searches listings that fit (needs a key).

## Talk to it

Hold the microphone (or press V) to talk, tap it to talk until you pause, or switch on Hands-free for a continuous spoken conversation: it listens, answers aloud, and you can speak over it to interrupt. Mute turns the spoken replies off. Voice needs a browser with speech recognition.

## Safety, step by step

1. Review > Safety. Pick a country rule pack at the top (Finland or Sweden) or keep the generic defaults.
2. Set the people count with − and + (Auto uses room areas), then press **Drill**. Everyone walks out on the plan with a clock; the chips show the time out, any trapped people and the bottleneck. **Block exit** closes one exit and reruns it.
3. Fire and Access tabs list findings. The eye button shows one on the plan; Fix applies the suggested change.
4. Equipment shows suggested alarms, extinguishers, signs and blankets.
5. **Report** opens the printable fire and access report.

## Move in

Share > Move in lists every piece with its verdict. Press Play to carry the pieces in one by one through the entrance and each door, or click a row to see the door that decides its verdict.

## Share and export

Share > Export has three groups. Share: copy the link, show a QR code in the panel, or start a layout poll. Files: PDF, SVG, GLB, CSV, DXF, IFC4, USDZ, JSON. List: the shopping list with totals and CSV.

## Links

Every section can be opened directly, which is how the demos are made:

```
?nav=<capture|drawings|building|describe|layouts|checks|inspire|furniture|create|shop|budget|walk|safety|export|movein|render>
 &sample=1          start from the small starter room
 &view=<2d|split|3d>
 &theme=<dark|light|system>
 &open=<settings|command|checks|demo>      settings, search, checks or the guided demo
 &start=<plan|villa|room>                  one-click start that lands on a finished state
 &show=1                                   the hands-free film (show=loop repeats it, voice=1 narrates)
 &demo=<villa|office|lshape>[&furnish=1]   a demo building, optionally furnished
 &poll=<id>                                open a shared layout poll
```

Demo links on the live site:

- [Plan to 3D](https://junction26.github.io/SpaceLens/?start=plan)
- [A villa](https://junction26.github.io/SpaceLens/?start=villa)
- [Layouts](https://junction26.github.io/SpaceLens/?nav=layouts&sample=1&view=split)
- [Safety](https://junction26.github.io/SpaceLens/?nav=safety&sample=1&view=split)
- [The film](https://junction26.github.io/SpaceLens/?show=1): about 82 seconds, no clicks; Esc or any click stops it

A two-minute spoken script is in [DEMO.md](DEMO.md).

## Gemini key (optional)

1. Create a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. Paste it into Settings in the app, or put `VITE_GEMINI_KEY=<your key>` in `.env.local` for local development (see `.env.example`).

The key stays in your browser and is sent only to the Gemini API. Calling the model from the page keeps the project backend-free, but any key embedded in a deployed bundle can be read by its visitors, so the deployed site ships without one. The optional server in `server/` can hold the key instead. The model router picks, per task (fast, smart, vision), the first candidate model that is healthy and quick for your key.
