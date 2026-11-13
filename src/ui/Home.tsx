import { useStore } from '../core/store';
import { sampleRoom } from '../core/sample';

export function Home() {
  const dispatch = useStore((s) => s.dispatch);
  const setMode = useStore((s) => s.setMode);
  return (
    <div className="home">
      <h1>SpaceLens</h1>
      <p>Measure a room, redesign it, walk through it.</p>
      <button onClick={() => setMode('capture')}>Create a space</button>
      <button onClick={() => { dispatch({ type: 'REPLACE_MODEL', model: sampleRoom() }); setMode('design'); }}>Open sample room</button>
    </div>
  );
}
