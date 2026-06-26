import { drive, getActiveDriver } from './drive.js';
import { type SpringParams } from './spring.js';

export class MotionValue {
  private _value: number | string;
  private _velocity: number = 0;
  private _targetValue: number | string;
  private _springParams: SpringParams;
  private _onChangeCallbacks: Set<(value: number | string) => void> = new Set();
  private _mockElement: Element;

  constructor(
    initialValue: number | string,
    params: SpringParams = { mass: 1, stiffness: 100, damping: 10 },
  ) {
    this._value = initialValue;
    this._targetValue = initialValue;
    this._springParams = params;
    this._mockElement = {} as Element;
  }

  get value(): number | string {
    return this._value;
  }

  get velocity(): number {
    return this._velocity;
  }

  get targetValue(): number | string {
    return this._targetValue;
  }

  get springParams(): SpringParams {
    return this._springParams;
  }

  setSpringParams(params: SpringParams): void {
    this._springParams = params;
  }

  setTarget(targetValue: number | string): Promise<void> {
    this._targetValue = targetValue;

    return drive({
      from: this._value,
      to: targetValue,
      spring: this._springParams,
      target: this._mockElement,
      onStep: (v) => {
        this._value = v;
        const active = getActiveDriver(this._mockElement);
        if (active) {
          this._velocity = active.current().velocity;
        } else {
          this._velocity = 0;
        }
        for (const cb of this._onChangeCallbacks) {
          cb(v);
        }
      },
    });
  }

  onChange(callback: (value: number | string) => void): () => void {
    this._onChangeCallbacks.add(callback);
    return () => {
      this._onChangeCallbacks.delete(callback);
    };
  }

  destroy(): void {
    this._onChangeCallbacks.clear();
    const active = getActiveDriver(this._mockElement);
    if (active) {
      active.stop();
    }
  }
}
