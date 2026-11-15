/** Compact button text for a relaxation option: "Leave out the desk chair" becomes "Skip desk chair". */
export function shortRelax(label: string): string {
  return label
    .replace(/^Leave out the /i, 'Skip ')
    .replace(/^Use the (.+) instead$/i, 'Swap to $1')
    .replace(/ (\d+x\d+)$/, '');
}
