import { describe, expect, it } from 'vitest';
import { sampleRoom } from '../../core/sample';
import { ifcGuid, modelToIfc } from './ifcWrite';

function parse(text: string) {
  const data = text.split('\nDATA;\n')[1].split('\nENDSEC;')[0];
  const ents = new Map<number, { name: string; args: string }>();
  for (const line of data.split('\n').filter(Boolean)) {
    const m = /^#(\d+)=([A-Z0-9]+)\((.*)\);$/.exec(line);
    expect(m, line).not.toBeNull();
    ents.set(Number(m![1]), { name: m![2], args: m![3] });
  }
  return ents;
}

describe('ifc writer', () => {
  const model = sampleRoom();
  const text = modelToIfc(model);
  const ents = parse(text);
  const count = (n: string) => [...ents.values()].filter((e) => e.name === n).length;

  it('has a valid header', () => {
    expect(text.startsWith('ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(')).toBe(true);
    expect(text).toContain("FILE_SCHEMA(('IFC4'));");
    expect(text).toContain('FILE_NAME(');
    expect(text.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);
  });
  it('resolves every reference', () => {
    for (const e of ents.values()) {
      const noStr = e.args.replace(/'(?:[^']|'')*'/g, '');
      for (const r of noStr.matchAll(/#(\d+)/g)) expect(ents.has(Number(r[1])), r[0]).toBe(true);
    }
  });
  it('matches model counts', () => {
    expect(count('IFCPROJECT')).toBe(1);
    expect(count('IFCSITE')).toBe(1);
    expect(count('IFCBUILDING')).toBe(1);
    expect(count('IFCBUILDINGSTOREY')).toBe(1);
    expect(count('IFCSPACE')).toBe(model.spaces.length);
    expect(count('IFCWALLSTANDARDCASE')).toBe(model.spaces[0].polygon.length);
    expect(count('IFCDOOR')).toBe(1);
    expect(count('IFCWINDOW')).toBe(1);
    expect(count('IFCFURNISHINGELEMENT')).toBe(model.furniture.length);
    expect(count('IFCRELCONTAINEDINSPATIALSTRUCTURE')).toBe(1);
    expect(count('IFCEXTRUDEDAREASOLID')).toBe(1 + 4 + 2 + model.furniture.length);
  });
  it('writes metre units and deterministic 22-char guids', () => {
    expect(text).toContain('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)');
    expect(ifcGuid('a')).toHaveLength(22);
    expect(ifcGuid('a')).toBe(ifcGuid('a'));
    expect(ifcGuid('a')).not.toBe(ifcGuid('b'));
    expect(modelToIfc(model)).toBe(text);
  });
});
