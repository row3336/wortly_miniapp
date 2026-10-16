import { screen, waitFor, type waitForOptions } from "@testing-library/react";
import { expect } from "vitest";

/**
 * The control a user may press now (P03 §4.1 «Правило кнопки», C335; M-P03-9/10): while the write gate holds, a manual
 * control is visible and inactive, and a press does nothing — an App test presses only once the button is active again,
 * as the user does. The assertion of the test stays the same; only the moment of the press waits for the gate.
 */
export async function activeButton(name: string | RegExp, options?: waitForOptions): Promise<HTMLButtonElement> {
  return waitFor(() => {
    const button = screen.getByRole("button", { name }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    return button;
  }, { timeout: 5_000, ...options });
}
