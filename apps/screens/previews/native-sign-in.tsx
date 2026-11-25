import { SignInScreen } from "../../../blocks/native-sign-in/sign-in-screen.tsx";

const actions = {
  requestCode: async () => true,
  signIn: async () => true,
};

export default function Preview() {
  return <SignInScreen actions={actions} onSignedIn={() => {}} />;
}
