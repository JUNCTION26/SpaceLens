# Two-minute demo

Everything here works on the live site without a key. Each step has a deep link, so you can jump straight to it. Base URL: `https://junction26.github.io/SpaceLens/`. For a local run, use `http://localhost:5173/`.

The built-in tour (`?sample=1&open=demo`, or **Guided demo** at the bottom of the sidebar) walks through load, edit, describe, layouts, walk, door fit, what-if and deliver in eight captioned steps.

| Time | Link | Do | Say |
| --- | --- | --- | --- |
| 0:00 | [`?nav=drawings&sample=1`](https://junction26.github.io/SpaceLens/?nav=drawings&sample=1) | Open one of the sample Swiss floor plans. Ask "How many apartments are shown?" and click the answer. | A blueprint that answers. The page region that proves it is highlighted, and the answer says whether it is printed, calculated or inferred. |
| 0:25 | same | Ask for the area of a room, then a question it cannot support. | When the page does not say, it abstains. On the Stoa questions that is 99.5% correct when it answers. |
| 0:40 | [`?nav=building&sample=1&view=split`](https://junction26.github.io/SpaceLens/?nav=building&sample=1&view=split) | Pick a shell and a room programme, generate the floor. | From a programme to rooms with walls, doors and windows. These are labelled as estimates. |
| 0:55 | [`?nav=layouts&sample=1&view=split`](https://junction26.github.io/SpaceLens/?nav=layouts&sample=1&view=split) | Describe a use, generate layouts, open the decisions for one. | Each placement has a reason, measured numbers and a verdict from an independent checker. |
| 1:10 | [`?nav=create&sample=1&view=split`](https://junction26.github.io/SpaceLens/?nav=create&sample=1&view=split) | Describe a piece, give a width and height, place it. | Any object, built to your exact size. The layout rules treat it like a catalogue piece. |
| 1:25 | [`?nav=shop&sample=1`](https://junction26.github.io/SpaceLens/?nav=shop&sample=1) | Search for a sofa with a budget and a maximum width. | Real listings, checked against the room, the door and the budget (needs a key). |
| 1:35 | [`?nav=walk&sample=1&view=3d`](https://junction26.github.io/SpaceLens/?nav=walk&sample=1&view=3d) | Walk the room, run a route for the wheelchair profile, test a sofa through the door. | Walk it before you buy anything. |
| 1:45 | [`?nav=safety&sample=1&view=2d`](https://junction26.github.io/SpaceLens/?nav=safety&sample=1&view=2d) | Run the check, open one finding, show the printable evacuation plan. | Exits, reach and an evacuation estimate, with every assumption on the page and what is not covered said plainly. |
| 1:55 | any | Click the agent bar and say "move the desk under the window". | You can also just talk to it. It sketches the move first, then does it, and it can be undone. |

Notes for presenters:

- The agent, shop, object generation and the model fallback in Drawings need a Gemini key (Settings). Everything else, including the design solver, safety and the drawings index, runs locally.
- `?coach=0` skips the first-run tour, and `&theme=dark` or `&theme=light` sets the theme.
