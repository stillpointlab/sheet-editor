export function columnLabel(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError('Column index must be a non-negative safe integer');
  }

  let value = index + 1;
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}
