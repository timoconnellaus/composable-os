// Labels for agreement documents (stage 44): what the admin shows for each kind and choice.
export const KIND_LABELS: Record<string, string> = {
  terms: "Terms",
  waiver: "Waiver",
  health: "Health questions",
  guardian: "Parent or guardian consent",
  other: "Other",
};

export const HOW_LABELS: Record<string, string> = {
  typed: "Tick the box and type their name",
  drawn: "Type their name and draw a signature",
};

export const WHO_LABELS: Record<string, string> = {
  participant: "The person who trains or attends",
  payer: "The person who pays",
};

export const FOR_LABELS: Record<string, string> = {
  everyone: "Everyone",
  dependants: "Only a child a parent or guardian is linked to",
};

export const CHANGE_LABELS: Record<string, string> = {
  first: "First version",
  small: "Small change",
  agree_again: "Everyone agrees again",
};
