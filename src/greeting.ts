/** Example domain logic: deterministic and independent of Pi. Replace freely. */
export function formatGreeting(name: string): string {
  return `Hello, ${name.trim() || "world"}!`;
}
