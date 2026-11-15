import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyQuat, axisAngleToQuat, eulerToQuat, quatMul, quatToEuler, quatToMatrix } from './rot';
import { rotMatrix } from './spec';

const H = Math.PI / 2;
const close = (a: ArrayLike<number>, b: number[]) => b.forEach((x, i) => expect(a[i]).toBeCloseTo(x, 6));

describe('rot helpers', () => {
  it('90 degrees about each axis on unit vectors', () => {
    close(applyQuat([1, 0, 0], axisAngleToQuat([0, 0, 1], H)), [0, 1, 0]);
    close(applyQuat([0, 1, 0], axisAngleToQuat([1, 0, 0], H)), [0, 0, 1]);
    close(applyQuat([0, 0, 1], axisAngleToQuat([0, 1, 0], H)), [1, 0, 0]);
    close(applyQuat([1, 0, 0], eulerToQuat(0, H, 0)), [0, 0, -1]);
  });
  it('combined XYZ rotation matches the hand-checked result', () => {
    // Intrinsic XYZ = Rx * Ry * Rz; apply Rz first. (1,0,0): Rz -> (0,1,0), Ry -> same, Rx -> (0,0,1).
    close(applyQuat([1, 0, 0], eulerToQuat(H, H, H)), [0, 0, 1]);
  });
  it('quaternion product applies the right factor first', () => {
    const qz = axisAngleToQuat([0, 0, 1], H), qx = axisAngleToQuat([1, 0, 0], H);
    close(applyQuat([1, 0, 0], quatMul(qx, qz)), [0, 0, 1]);
  });
  it('matches three.js for Euler, matrices and round trips', () => {
    for (const [x, y, z] of [[0.3, -0.5, 0.9], [1.2, 0.4, -0.7], [-1, 1.3, 0.2]]) {
      const tq = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ'));
      close(eulerToQuat(x, y, z), [tq.x, tq.y, tq.z, tq.w]);
      const e = new THREE.Matrix4().makeRotationFromQuaternion(tq).elements;
      close(rotMatrix([x, y, z]), [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]]);
      close(quatToMatrix(eulerToQuat(x, y, z)), [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]]);
      const v = new THREE.Vector3(0.4, -1.1, 2).applyQuaternion(tq);
      close(applyQuat([0.4, -1.1, 2], eulerToQuat(x, y, z)), [v.x, v.y, v.z]);
      close(quatToEuler(eulerToQuat(x, y, z)), [x, y, z]);
    }
    const d = (80 * Math.PI) / 180;
    for (const [x, y, z] of [[d, -d, d], [-d, d, 0.1], [0.5, 0, -d]]) close(quatToEuler(eulerToQuat(x, y, z)), [x, y, z]);
  });
});
