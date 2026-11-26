---
title: "Jobs: permissions and roles"
sidebar:
  label: "Permissions and roles"
  order: 3
editUrl: false
---

A tool with no permission of its own is held by admins and members as any tool is (a viewer only when its risk is `read`). A permission a tool names is held by the roles that list it; a **restricted** one is held by admins and by a staff account an admin granted it, and by nobody else; a **grantable** one can be granted to a staff account one by one.

## Permissions its tools declare

| Permission | Tools | Restricted | Grantable | Roles holding it | What a grant gives |
| --- | --- | --- | --- | --- | --- |
| `jobs:manage` | [enquire](/packs/jobs/tools/#enquire), [jobSummary](/packs/jobs/tools/#jobsummary), [recordAcceptance](/packs/jobs/tools/#recordacceptance), [myVisits](/packs/jobs/tools/#myvisits), [myJob](/packs/jobs/tools/#myjob), [markOnTheWay](/packs/jobs/tools/#markontheway), [markOnSite](/packs/jobs/tools/#markonsite), [markDone](/packs/jobs/tools/#markdone), [markMissed](/packs/jobs/tools/#markmissed), [addMaterial](/packs/jobs/tools/#addmaterial), [proposeVariation](/packs/jobs/tools/#proposevariation), [approveVariation](/packs/jobs/tools/#approvevariation), [declineVariation](/packs/jobs/tools/#declinevariation), [withdrawVariation](/packs/jobs/tools/#withdrawvariation) |   |   |   |   |
| `jobs:schedule` | [bookVisit](/packs/jobs/tools/#bookvisit), [moveVisit](/packs/jobs/tools/#movevisit), [cancelVisit](/packs/jobs/tools/#cancelvisit), [assignCrew](/packs/jobs/tools/#assigncrew), [removeCrew](/packs/jobs/tools/#removecrew) |   |   |   |   |
| `jobs:crew` | [myVisits](/packs/jobs/tools/#myvisits), [myJob](/packs/jobs/tools/#myjob), [markOnTheWay](/packs/jobs/tools/#markontheway), [markOnSite](/packs/jobs/tools/#markonsite), [markDone](/packs/jobs/tools/#markdone), [markMissed](/packs/jobs/tools/#markmissed), [addMaterial](/packs/jobs/tools/#addmaterial), [proposeVariation](/packs/jobs/tools/#proposevariation) |   |   | `jobs.crew` |   |
| `jobs:prices` | [addLine](/packs/jobs/tools/#addline), [editLine](/packs/jobs/tools/#editline), [approveLine](/packs/jobs/tools/#approveline), [voidLine](/packs/jobs/tools/#voidline), [unbilled](/packs/jobs/tools/#unbilled), [exportUnbilled](/packs/jobs/tools/#exportunbilled) | yes | yes |   | Jobs: see and set prices, costs and rates on jobs, approve and void lines, and download what is unbilled |

## Roles

### Crew (`jobs.crew`)

Works on customers' jobs: sees the jobs, visits and sites they have a place on, from a week before the visit to a week after, marks a visit on the way, on site and done, records materials and proposes extra work. Sees no prices.

|  |  |
| --- | --- |
| Permissions | `jobs:crew` |
| Reads | `jobs.job`, `jobs.visit`, `jobs.assignment`, `jobs.visittype` |

## Who may call, beyond permissions

| Tool | A person only | A person approves | Every staff account | Core permission |
| --- | --- | --- | --- | --- |
| [recordAcceptance](/packs/jobs/tools/#recordacceptance) | yes |   |   |   |
| [bookVisit](/packs/jobs/tools/#bookvisit) |   | yes |   |   |
| [moveVisit](/packs/jobs/tools/#movevisit) |   | yes |   |   |
| [cancelVisit](/packs/jobs/tools/#cancelvisit) |   | yes |   |   |
| [assignCrew](/packs/jobs/tools/#assigncrew) |   | yes |   |   |
| [removeCrew](/packs/jobs/tools/#removecrew) |   | yes |   |   |
| [markOnTheWay](/packs/jobs/tools/#markontheway) | yes |   |   |   |
| [markOnSite](/packs/jobs/tools/#markonsite) | yes |   |   |   |
| [markDone](/packs/jobs/tools/#markdone) | yes |   |   |   |
| [markMissed](/packs/jobs/tools/#markmissed) | yes |   |   |   |
| [editLine](/packs/jobs/tools/#editline) |   | yes |   |   |
| [approveLine](/packs/jobs/tools/#approveline) |   | yes |   |   |
| [voidLine](/packs/jobs/tools/#voidline) |   | yes |   |   |
| [approveVariation](/packs/jobs/tools/#approvevariation) | yes |   |   |   |
| [declineVariation](/packs/jobs/tools/#declinevariation) | yes |   |   |   |
| [withdrawVariation](/packs/jobs/tools/#withdrawvariation) |   | yes |   |   |
| [exportUnbilled](/packs/jobs/tools/#exportunbilled) | yes |   |   |   |
