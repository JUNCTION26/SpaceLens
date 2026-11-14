# Two-minute demo

Everything here works on the live site without a key. Each step has a deep link, so you can jump straight to it. Base URL: `https://junction26.github.io/SpaceLens/`. For a local run, use `http://localhost:5173/`.

The built-in tour (`?sample=1&open=demo`, or **Guided demo** at the bottom of the sidebar) walks through load, edit, describe, layouts, walk, door fit, what-if and deliver in eight captioned steps.

| Time | Link | Do | Say |
| --- | --- | --- | --- |
| 0:00 | [`?nav=drawings&sample=1`](https://junction26.github.io/SpaceLens/?nav=drawings&sample=1) | Open the sample `floor10281` plan from the list. The page appears, then the building is built. | A real floor plan in, a building out: 21 rooms, doors and windows, with no model call. |
| 0:20 | same | Click a room in the list: the page zooms to it and shows printed against computed area. Ask a question, such as how many rooms. | Every wall and room points back at the page, and answers show their evidence. 98.7% of printed areas match within 2%, and door and window counts are the weak part. |
| 0:40 | 3D view | Switch to 3D, then walk through the doors or start the tour. | Walk it. The rooms are connected through real doors. |
| 0:55 | [`?nav=building&view=split`](https://junction26.github.io/SpaceLens/?nav=building&view=split) | Use **Furnish every room**. | Every room furnished from the same design pipeline. |
| 1:10 | agent bar | Say or type "add a pink princess bed". | Say what you want. It makes the object to size, sketches where it goes, then places it. |
| 1:25 | [`?nav=layouts&sample=1&view=split`](https://junction26.github.io/SpaceLens/?nav=layouts&sample=1&view=split) | Open "Why this layout" on a candidate. | Each placement has a reason, measured numbers and a verdict from an independent checker. |
| 1:40 | [`?nav=safety&sample=1&view=split`](https://junction26.github.io/SpaceLens/?nav=safety&sample=1&view=split) | Run the evacuation, open the assumptions. | Exits and reach, with every assumption visible and what is not covered stated plainly. |
| 1:50 | [`?nav=export&sample=1`](https://junction26.github.io/SpaceLens/?nav=export&sample=1) | Show the PDF, schedule, 3D model and share link. | Hand it over. |

Notes for presenters:

- The agent, shop, object generation and the model fallback in Drawings need a Gemini key (Settings). Building a floor from a PDF and the design solver do not. Everything else, including the design solver, safety and the drawings index, runs locally.
- `?coach=0` skips the first-run tour, and `&theme=dark` or `&theme=light` sets the theme.
