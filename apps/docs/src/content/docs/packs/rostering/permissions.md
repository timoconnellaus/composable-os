---
title: "Rostering: permissions and roles"
sidebar:
  label: "Permissions and roles"
  order: 3
editUrl: false
---

A tool with no permission of its own is held by admins and members as any tool is (a viewer only when its risk is `read`). A permission a tool names is held by the roles that list it; a **restricted** one is held by admins and by a staff account an admin granted it, and by nobody else; a **grantable** one can be granted to a staff account one by one.

## Permissions its tools declare

| Permission | Tools | Restricted | Grantable | Roles holding it | What a grant gives |
| --- | --- | --- | --- | --- | --- |
| `rostering:team` | [me](/packs/rostering/tools/#me), [week](/packs/rostering/tools/#week), [mine](/packs/rostering/tools/#mine), [offers](/packs/rostering/tools/#offers), [offer](/packs/rostering/tools/#offer), [withdraw](/packs/rostering/tools/#withdraw), [take](/packs/rostering/tools/#take), [away](/packs/rostering/tools/#away), [back](/packs/rostering/tools/#back), [myAway](/packs/rostering/tools/#myaway), [feed](/packs/rostering/tools/#feed), [feedRotate](/packs/rostering/tools/#feedrotate), [feedRevoke](/packs/rostering/tools/#feedrevoke), [myPayPeriods](/packs/rostering/tools/#mypayperiods), [myPay](/packs/rostering/tools/#mypay), [checklist](/packs/rostering/tools/#checklist), [tick](/packs/rostering/tools/#tick), [checklistDone](/packs/rostering/tools/#checklistdone) |   |   | `rostering.team` |   |
| `rostering:roster` | [me](/packs/rostering/tools/#me), [week](/packs/rostering/tools/#week), [mine](/packs/rostering/tools/#mine), [offers](/packs/rostering/tools/#offers), [offer](/packs/rostering/tools/#offer), [withdraw](/packs/rostering/tools/#withdraw), [take](/packs/rostering/tools/#take), [away](/packs/rostering/tools/#away), [back](/packs/rostering/tools/#back), [myAway](/packs/rostering/tools/#myaway), [feed](/packs/rostering/tools/#feed), [feedRotate](/packs/rostering/tools/#feedrotate), [feedRevoke](/packs/rostering/tools/#feedrevoke), [myPayPeriods](/packs/rostering/tools/#mypayperiods), [myPay](/packs/rostering/tools/#mypay), [checklist](/packs/rostering/tools/#checklist), [tick](/packs/rostering/tools/#tick), [checklistDone](/packs/rostering/tools/#checklistdone) |   | yes |   | Rostering: see the roster and their own shifts, offer and take shifts, say when they are away, have their own calendar feed and see their own hours for each pay period. For a coach or anyone with another role who is rostered. |
| `rostering:manage` | [assign](/packs/rostering/tools/#assign), [check](/packs/rostering/tools/#check), [qualify](/packs/rostering/tools/#qualify), [qualifications](/packs/rostering/tools/#qualifications), [awayFor](/packs/rostering/tools/#awayfor), [awayList](/packs/rostering/tools/#awaylist), [uncovered](/packs/rostering/tools/#uncovered), [markNotWorked](/packs/rostering/tools/#marknotworked), [candidates](/packs/rostering/tools/#candidates), [checklistRuns](/packs/rostering/tools/#checklistruns), [checklistCorrect](/packs/rostering/tools/#checklistcorrect), [follow](/packs/rostering/tools/#follow), [people](/packs/rostering/tools/#people), [patterns](/packs/rostering/tools/#patterns), [setPattern](/packs/rostering/tools/#setpattern), [planCheck](/packs/rostering/tools/#plancheck) | yes | yes |   | Rostering, rosters others: put people on shifts, say who may do which work, record others' time off and see everyone's, see shifts with nobody on them, mark a shift not worked, and see how everyone's checklists went and tick one for someone. Admins hold it. |
| `rostering:pay` | [payBasis](/packs/rostering/tools/#paybasis), [payBases](/packs/rostering/tools/#paybases), [periods](/packs/rostering/tools/#periods), [periodTotals](/packs/rostering/tools/#periodtotals), [lock](/packs/rostering/tools/#lock), [reopen](/packs/rostering/tools/#reopen), [export](/packs/rostering/tools/#export) | yes | yes |   | Rostering, pay: say who is counted for pay, see each pay period's hours and shifts, lock, reopen and export them for payroll. No rates or money are held. Admins hold it. |

## Roles

### Rostered team (`rostering.team`)

Sees the roster and their own shifts, offers and takes shifts, says when they are away, has their own calendar feed and sees their own hours for each pay period. Nothing else: no records, no people, no settings.

|  |  |
| --- | --- |
| Permissions | `rostering:team` |
| Reads | no records |

## Who may call, beyond permissions

| Tool | A person only | A person approves | Every staff account | Core permission |
| --- | --- | --- | --- | --- |
| [offer](/packs/rostering/tools/#offer) | yes |   |   |   |
| [withdraw](/packs/rostering/tools/#withdraw) | yes |   |   |   |
| [take](/packs/rostering/tools/#take) | yes |   |   |   |
| [away](/packs/rostering/tools/#away) | yes |   |   |   |
| [back](/packs/rostering/tools/#back) | yes |   |   |   |
| [feedRotate](/packs/rostering/tools/#feedrotate) | yes |   |   |   |
| [feedRevoke](/packs/rostering/tools/#feedrevoke) | yes |   |   |   |
| [myPayPeriods](/packs/rostering/tools/#mypayperiods) | yes |   |   |   |
| [myPay](/packs/rostering/tools/#mypay) | yes |   |   |   |
| [assign](/packs/rostering/tools/#assign) |   | yes |   |   |
| [qualify](/packs/rostering/tools/#qualify) |   | yes |   |   |
| [awayFor](/packs/rostering/tools/#awayfor) | yes |   |   |   |
| [awayList](/packs/rostering/tools/#awaylist) | yes |   |   |   |
| [markNotWorked](/packs/rostering/tools/#marknotworked) |   | yes |   |   |
| [checklist](/packs/rostering/tools/#checklist) | yes |   |   |   |
| [tick](/packs/rostering/tools/#tick) | yes |   |   |   |
| [checklistDone](/packs/rostering/tools/#checklistdone) | yes |   |   |   |
| [checklistRuns](/packs/rostering/tools/#checklistruns) | yes |   |   |   |
| [checklistCorrect](/packs/rostering/tools/#checklistcorrect) | yes |   |   |   |
| [follow](/packs/rostering/tools/#follow) |   | yes |   |   |
| [setPattern](/packs/rostering/tools/#setpattern) |   | yes |   |   |
| [planCheck](/packs/rostering/tools/#plancheck) | yes |   |   |   |
| [payBasis](/packs/rostering/tools/#paybasis) | yes |   |   |   |
| [payBases](/packs/rostering/tools/#paybases) | yes |   |   |   |
| [periods](/packs/rostering/tools/#periods) | yes |   |   |   |
| [periodTotals](/packs/rostering/tools/#periodtotals) | yes |   |   |   |
| [lock](/packs/rostering/tools/#lock) | yes |   |   |   |
| [reopen](/packs/rostering/tools/#reopen) | yes |   |   |   |
| [export](/packs/rostering/tools/#export) | yes |   |   |   |

## The roster's rules

This pack sets the host's roster rules (`staffing`).

```json
{
  "rosters": "rostering:manage",
  "pays": "rostering:pay",
  "settings": {
    "offerCutoffMinutes": "offerCutoffMinutes",
    "uncoveredDays": "uncoveredDays",
    "payPeriod": "payPeriod",
    "payPeriodStart": "payPeriodStart",
    "payPeriodDay": "payPeriodDay"
  }
}
```
