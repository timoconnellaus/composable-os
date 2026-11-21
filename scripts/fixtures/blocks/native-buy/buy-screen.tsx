// A fixture: an app screen that buys, which a noPurchase block may not.
export function BuyScreen({ courses }: { courses: { useBuy(): { start: { mutate(): void } } } }) {
  const buy = courses.useBuy();
  return buy;
}
