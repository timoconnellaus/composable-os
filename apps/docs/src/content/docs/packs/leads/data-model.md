---
title: "Leads: data model"
sidebar:
  label: "Data model"
  order: 1
editUrl: false
---

It requires no other pack.

## Lead (`leads.lead`)

Inbound interest: a person and/or organisation who may buy, with a status, a source and an owner. Converting a lead creates a deal for the same organisation and person.

|  |  |
| --- | --- |
| Plural | Leads |
| Title field | `name` |
| Listed in | main |
| Indexes | `owner, status`; `status, createdAt`; `person`; `organisation` |
| Owner field | `owner` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   | Left blank, the person's or organisation's name followed by “lead”. |
| `person` | `relation` | Person |   | to `person` |   |
| `organisation` | `relation` | Organisation |   | to `organisation` |   |
| `status` | `select` | Status |   | one of `new`, `contacted`, `qualified`, `unqualified`, `converted`; default `"new"` | Where the lead is. Converted is set by converting the lead; unqualified needs a reason. |
| `source` | `select` | Source |   | one of `website`, `referral`, `event`, `outbound`, `partner`, `import`, `other`; default `"other"` | Where the lead came from. |
| `owner` | `user` | Owner |   |   |   |
| `unqualifiedReason` | `select` | Unqualified reason |   | one of `noBudget`, `noNeed`, `noAuthority`, `badTiming`, `competitor`, `unresponsive`, `other` | Why the lead was disqualified. |
| `notes` | `longText` | Notes |   |   |   |
| `deal` | `relation` | Deal |   | to `deals.deal`; read-only | The deal the lead was converted into. |
| `convertedAt` | `date` | Converted on |   | read-only | Set when the lead is converted. |
| `ageDays` | `formula` | Age (days) |   |   |   |

### Relations

- `person` → `person`
- `organisation` → `organisation`
- `deal` → `deals.deal`

## Fields on other objects

### On `deals.deal`

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `lead` | `relation` | Lead |   | to `leads.lead`; read-only | The lead this deal was converted from. |

## Views

| View | Object | Label |
| --- | --- | --- |
| `leadsInbox` | `leads.lead` | Leads inbox |
| `myLeads` | `leads.lead` | My leads |
| `unassigned` | `leads.lead` | Unassigned |
| `leadsBoard` | `leads.lead` | Leads by status |

## On other records' pages

| Kind | Key | On | Label |
| --- | --- | --- | --- |
| tab | `personLeads` | `` | Leads |
| tab | `organisationLeads` | `` | Leads |
| panel | `leadDeal` | `` | Deal |
