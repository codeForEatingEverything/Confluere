/** vi.mock factories shared by the wizard tests. */
export const navModule = () => ({
  usePathname: () => "/borrow/american",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: () => {}, replace: () => {} }),
});
