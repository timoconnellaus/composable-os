// The questions section. Read by the section itself and by the page's FAQPage structured data, so
// the two can't drift apart. Each answer is a real buying objection, answered in one to three
// sentences.
export const QUESTIONS = [
  {
    q: "Who owns the software and the data?",
    a: "The data is yours, and you can have the code for your product whenever you want it. The source of the platform underneath is public.",
  },
  {
    q: "What does it cost?",
    a: "Once it's built, one subscription that covers hosting, updates, fixes, changes and support. The figure depends on what we compose for you, so you get it after the call.",
  },
  {
    q: "What if we stop working with Zero BS AI?",
    a: "You take the code and the data with you. Your team or another developer can carry on with the same toolkit.",
  },
  {
    q: "Can the AI change things without asking?",
    a: "Only what your admins allow. By default, new fields, bulk edits, deletes and outgoing messages wait for a person.",
  },
  {
    q: "Can it connect to the systems we already use?",
    a: "Yes: email, calendars, Slack, payments and webhooks today, each through a connection you control.",
  },
] as const;
