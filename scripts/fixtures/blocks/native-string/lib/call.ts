// A fixture: an operation named as a string, in a subfolder, and not listed in block.json.
export const cancel = (client: { mutation(name: string): unknown }) =>
  client.mutation("subscription.cancel");
