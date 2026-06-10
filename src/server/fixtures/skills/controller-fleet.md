# controller-fleet

Walking the entire fleet via `list_controllers`, filtering by organization, grouping in a report. Load it when the user asks "across the fleet": "find the controller with …", "who has Y configured", "where is X present", "how many controllers are online", "is ntp enabled on all of them", "report on my controllers".

Do not apply when:
- The user explicitly named a single SN, or `contextSNs` is non-empty and they say "this one"/"the current one" — work with it, not the fleet.
- The question is about **Zigbee** (devices, pairing, zigbee2mqtt) — first load the `zigbee` skill, it knows how to search correctly. If a fleet-wide walk on a zigbee topic is needed — load BOTH skills: `zigbee` + `controller-fleet`.

## Walk all of them, not "by the look of the name"

Until you've called `list_controllers`, you have no valid SNs — making them up is forbidden. After the call — walk **every online SN**, without selecting by hostname/comment (names lie or are empty). Skip offline ones, mention them at the end of the report.

`list_controllers` returns:

```json
[
  { "sn": "ABC123", "status": "online", "host": "192.168.1.10", "org": { "id": "org-1", "name": "wb-demo" } },
  { "sn": "OFF001", "status": "offline", "org": null }
]
```

`status` — `"online"` or `"offline"`. `org` can be `null`. `host` is present only on real controllers (fake/demo ones don't have it). Skip offline controllers and those without `host`.

## Filter by organization — only on explicit request

The user sees ALL their organizations at once. "Mine", "my controllers", "across the fleet" = ALL SNs from the response, not a single org.

Filter by `org.name` ONLY if the user named a specific one:
- "in the org wb-demo" → only `org.name == "wb-demo"`.
- without an explicit mention — don't filter.

## Order of actions

1. `list_controllers` — **once** per request, don't repeat it in the same response.
2. Split into online/offline.
3. For each online SN — the needed tool (`ssh_exec`, `mqtt_list_topics`, `mqtt_rpc`, ...). Read-only — can run in parallel, in a single model response. Writes — sequentially and with confirmation per SN.
4. Group the report by `org.name`:

   ```
   wb-demo:
     • ABC123 — yes, version 2.4.1
     • DEF456 — no
   aleksandr-degtyarev:
     • XYZ789 — yes, version 2.3.8
   offline (skipped): OFF001
   Total: 2 of 3 online.
   ```

## Pitfalls

- Selecting SNs by hostname ("I'll take the ones with prod in the name") — names can be empty, duplicated, misleading. Walk all of them.
- Not separating offline and demo — you waste timeouts on dead/mock controllers. `status: "offline"` or no `host` → straight to "skipped".
- Implicitly collapsing to a single organization. An empty `contextSNs` ≠ a single org is selected; by default the fleet = all.
- Filtering by org without the user explicitly saying so.
- A repeated `list_controllers` in one response — the list doesn't change within a single model response.

## Documentation

- Wiki Wiren Board Cloud: <https://wirenboard.com/wiki/Wiren_Board_Cloud>
