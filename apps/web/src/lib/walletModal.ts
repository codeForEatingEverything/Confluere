/** The AppKit modal when a Reown project id is configured (set once by app/providers); undefined otherwise. */
type Modal = { open: () => Promise<unknown> | void };
let modal: Modal | undefined;

export const setWalletModal = (m: Modal | undefined) => {
  modal = m;
};

export const walletModal = () => modal;

/** Fallback picker (no Reown id): the app's own modal listing the detected browser wallets. */
let pickerOpen = false;
const subs = new Set<() => void>();
export const openWalletPicker = (v = true) => {
  pickerOpen = v;
  subs.forEach((f) => f());
};
export const walletPickerStore = {
  subscribe: (f: () => void) => {
    subs.add(f);
    return () => subs.delete(f);
  },
  get: () => pickerOpen,
};
