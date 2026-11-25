import { PaymentMethod } from "../../../blocks/native-account-payment/payment.tsx";
import { Screen } from "../../../blocks/native-base/screen.tsx";

/** Drawn as the account screen opens it: on a screen of its own, under the section's name. */
export default function Preview() {
  return (
    <Screen title="Payment method">
      <PaymentMethod onManage={() => {}} />
    </Screen>
  );
}
