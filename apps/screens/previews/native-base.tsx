import { Button } from "../../../blocks/native-base/button.tsx";
import { Field } from "../../../blocks/native-base/field.tsx";
import { List } from "../../../blocks/native-base/list.tsx";
import { Row } from "../../../blocks/native-base/row.tsx";
import { Screen } from "../../../blocks/native-base/screen.tsx";
import { TabBar } from "../../../blocks/native-base/tab-bar.tsx";
import { Text } from "../../../blocks/native-base/text.tsx";

const tabs = [
  { key: "classes", label: "Classes" },
  { key: "bookings", label: "Bookings" },
  { key: "account", label: "Account" },
] as const;

const noop = () => {};

export default function Preview() {
  return (
    <>
      <Screen title="Account">
        <List>
          {[
            <Row key="m" title="Unlimited monthly" detail="Renews on 2 April" onPress={noop} />,
            <Row key="a" title="My agreements" detail="1 to agree to" onPress={noop} />,
            <Row key="p" title="Payment method" detail="Visa ending 4242" onPress={noop} />,
            <Row key="h" title="Booking history" onPress={noop} />,
          ]}
        </List>
        <Field label="Name" value="Jordan Lee" onChangeText={noop} />
        <Field
          label="Phone"
          value="0400 12"
          onChangeText={noop}
          error="Enter a full phone number."
        />
        <Text tone="muted">Your name and phone are shown to your coaches.</Text>
        <Button label="Save" onPress={noop} />
        <Button quiet label="Sign out" onPress={noop} />
      </Screen>
      <TabBar tabs={tabs} current="account" onChange={noop} />
    </>
  );
}
