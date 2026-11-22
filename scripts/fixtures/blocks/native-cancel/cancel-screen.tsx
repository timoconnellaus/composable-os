// A fixture: an app screen that cancels a subscription, which a noPurchase block may not.
export function CancelScreen({ courses }: { courses: { useCancelSubscription(): unknown } }) {
  return courses.useCancelSubscription();
}
