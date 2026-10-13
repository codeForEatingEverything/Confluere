// @vitest-environment jsdom
/** UI primitives (§7.5): button states, the amount well's error, drawers close on Esc, the token list filters. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Button, AmountInput, Drawer, Modal, TokenSelect, Segmented, OutcomeStrip, StatusPill, cleanAmount } from "../src/components/ui";
import { StepsLine, TxErrorLine } from "../src/components/ui/TxBits";
import { toastVisible } from "../src/components/ui/Toast";

afterEach(cleanup);

describe("button", () => {
  it("disabled and loading states; loading keeps its label and shows a spinner", () => {
    const { rerender } = render(<Button variant="primary" size="lg" disabled>Enter an amount</Button>);
    const b = screen.getByRole("button", { name: "Enter an amount" }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.className).toMatch(/btn-lg btn-primary/);
    rerender(<Button variant="primary" size="lg" loading>Placing order…</Button>);
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(b.querySelector(".spin")).toBeTruthy();
    expect(b.textContent).toBe("Placing order…");
  });
});

describe("amount well", () => {
  it("accepts digits and one dot, trims to the token's decimals", () => {
    expect(cleanAmount("1,5", 6)).toBe("1.5");
    expect(cleanAmount("1.1234567", 6)).toBe("1.123456");
    expect(cleanAmount("a1.2.3", 18)).toBe("1.23");
  });
  it("an error replaces nothing in the well's colour; it is a line in the corner", () => {
    const onChange = vi.fn();
    render(<AmountInput label="You deposit" value="" onChange={onChange} decimals={6} error="More than your loan" onMax={() => onChange("5")} balance="Balance 5" />);
    expect(screen.getByTestId("amount-error").textContent).toBe("More than your loan");
    fireEvent.change(screen.getByLabelText("You deposit"), { target: { value: "2.5" } });
    expect(onChange).toHaveBeenCalledWith("2.5");
    fireEvent.click(screen.getByRole("button", { name: "Max" }));
    expect(onChange).toHaveBeenCalledWith("5");
  });
});

describe("overlays", () => {
  it("a drawer closes on Esc (the dialog's cancel) and on the close button", () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="Lend USDC" testId="d">
        <p>body</p>
      </Drawer>,
    );
    const d = screen.getByTestId("d");
    fireEvent(d, new Event("cancel", { bubbles: false, cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(within(d).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(within(d).getByText("body")).toBeTruthy();
  });
  it("a modal renders its title and children while open", () => {
    render(
      <Modal open onClose={() => {}} title="Repay">
        <p>x</p>
      </Modal>,
    );
    expect(screen.getByText("Repay")).toBeTruthy();
  });
  it("the token list filters by name and by pasted address, and picks with a click", () => {
    const onPick = vi.fn();
    render(<TokenSelect open onClose={() => {}} title="You deposit" tokens={[{ address: "0xaa", symbol: "WHYPE" }, { address: "0xbb", symbol: "USDC" }]} onPick={onPick} allowAddress />);
    fireEvent.change(screen.getByLabelText("Search tokens"), { target: { value: "usd" } });
    const rows = screen.getAllByRole("button").filter((b) => b.hasAttribute("data-token-row"));
    expect(rows.map((o) => o.querySelector("span.block")?.textContent)).toEqual(["USDC"]);
    fireEvent.click(rows[0]!);
    expect(onPick).toHaveBeenCalledWith("0xbb");
    fireEvent.change(screen.getByLabelText("Search tokens"), { target: { value: "0x" + "1".repeat(40) } });
    expect(screen.getByText("Use this address")).toBeTruthy();
  });
});

describe("choices and status", () => {
  it("segmented control is a radio group that moves with arrow keys", () => {
    const onChange = vi.fn();
    render(<Segmented label="Style" value="a" onChange={onChange} options={[{ value: "a", label: "Repay any time" }, { value: "b", label: "Repay at maturity only" }]} />);
    const g = screen.getByRole("radiogroup", { name: "Style" });
    fireEvent.keyDown(g, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("b");
  });
  it("outcome strip has both sides; status pill draws its ring", () => {
    render(
      <>
        <OutcomeStrip left={{ title: "If you repay", body: "a" }} right={{ title: "If you don't", body: "b" }} />
        <StatusPill progress={0.5} data-testid="pill">
          Fills in about 1 min
        </StatusPill>
      </>,
    );
    expect(screen.getByTestId("outcome-strip").textContent).toBe("If you repayaIf you don'tb");
    // a ticking countdown is not a live region (screen readers would announce every tick)
    expect(screen.getByTestId("pill").querySelectorAll("circle")).toHaveLength(2);
    expect(screen.getByTestId("pill").getAttribute("role")).toBeNull();
  });
  it("two-step actions list both steps; wallet rejections never show as errors", () => {
    render(<StepsLine steps={[]} labels={["Approve USDC", "Deposit"]} />);
    expect(screen.getByTestId("steps-line").textContent).toBe("1Approve USDC2Deposit");
    const { container } = render(<TxErrorLine error={{ kind: "rejected", title: "You cancelled in your wallet. Nothing was sent." }} />);
    expect(container.textContent).toBe("");
  });
  it("toasts: every confirmed transaction says so, failures too; never a revert shown inline, never a wallet rejection", () => {
    expect(toastVisible({ id: 1, status: "success", title: "Borrow confirmed" })).toBe(true);
    expect(toastVisible({ id: 2, status: "success", title: "Withdrawn 33.78 USDC to your wallet." })).toBe(true);
    expect(toastVisible({ id: 3, status: "failed", title: "x", error: { kind: "reverted", title: "x" } })).toBe(false);
    expect(toastVisible({ id: 4, status: "failed", title: "x", hash: "0x1", error: { kind: "reverted", title: "x" } })).toBe(true);
    expect(toastVisible({ id: 5, status: "rejected", title: "x" })).toBe(false);
    void act;
  });
});
