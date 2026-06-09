# skill-creator

How to write a short, useful skill and save it to the catalog via `create_skill`. Load this when the user asks "study X and remember it", "read the docs and learn", "create/update a skill about Y", "make a skill out of this", "delete skill Z". A skill is a compact instruction that you (the model) will receive in a future conversation via `load_skill("<name>")`: not a retelling of documentation, but an imperative distillation — how to do it right, what not to do, typical pitfalls, where to go for details.

## When to write a skill

- The user explicitly asks: "remember this", "create/update a skill about X", "make a skill out of this".
- The topic is recurring (rules, Modbus, updates) — not a one-off question.
- There is already concrete material: real channel/command names, error messages, doc URLs.

Don't write one: a single question, general reasoning, retelling of one article.

## Process

1. **Check the catalog** — a suitable skill may already exist. If it does and the user asks to "update" — call `create_skill` with the same `name` (upsert).
2. **Gather specifics** — before writing, understand the topic:
   - `ssh_exec` / `read_file` — look at the configs, packages, logs on the controller
   - `web_fetch` — load documentation from the wiki/GitHub directly
   - `web_search` — search the internet if the protocol/device is unfamiliar (DALI, DMX, KNX)
   - `mqtt_rpc` — find out the current config, templates, parameters via the drivers' RPC
   - A live run on the controller is the best source of truth.
3. **Write `content`** in the format below. `name` — kebab-case, short (`wb-rules`, `controller-backup`).
4. **Show it to the user** — especially the lead paragraph (it will be the trigger in the catalog), get confirmation.
5. **Call `create_skill({name, content})`** — the skill will immediately appear in the catalog of future conversations.

Deletion — `delete_skill({name})`. User skills only; system skills are protected.

## How to write the content

Write for your future self, already busy with the user's task. Save its (your) attention.

- **Imperative, not narrative.** "Use the RPC `wbrules/Editor/Save`" > "the RPC is usually used".
- **Explicit prohibitions.** "Do NOT edit `/etc/wb-mqtt-serial.conf` via `write_file`" is stronger than any "it is recommended".
- **Real names in examples.** `dev["wb-mr6c_7/K1"]`, not `dev["device/channel"]` — abstract placeholders the model will insert into code literally.
- **Concrete error strings.** If you know the text from a log — write it down verbatim. The model will link cause to effect.
- **Links via http(s).** Only `web_fetch`-compatible URLs, no "see in the code".
- **Don't duplicate the system prompt.** Topology, the rules about SN, the priority of web_fetch — the model already has all of this.
- **Length 30–150 lines.** Longer — you're probably retelling documentation. Split into two skills.

### Specify the tools for performing the task

The skill is read by a future model that doesn't know how to act. Explicitly write which tools to use to solve the task per the skill:

- `write_file(sn, path, content)` — write a script/config to the controller
- `ssh_exec(sn, command)` — run a command (chmod, launch, check the result)
- `read_file(sn, path)` — read a file
- `mqtt_rpc` / `mqtt_read` / `mqtt_publish` — working with MQTT and the drivers' RPC
- `web_fetch` / `web_search` — documentation and search

Example: a skill about a custom serial protocol should contain "put the script with `write_file(sn, "/mnt/data/scripts/my-proto.py", content)`, do `ssh_exec(sn, "chmod +x /mnt/data/scripts/my-proto.py")`, run it via `ssh_exec`". Not an abstract "create a file on the controller".

## Structure

Mandatory: `# <name>` on the first line, a blank line, a lead paragraph of 1–3 sentences, then sections. **The lead paragraph matters most** — the server extracts it as the `description` and shows it in the catalog. It is the trigger "under which phrasings to load the skill": write live user phrasings, not tags.

Good: "Modbus/RS-485 on the controller. Access via the RPC `wb-mqtt-serial/...`. Load on 'channel is not published', 'scan the bus', 'add a device on RS-485'."

Bad: "A skill about modbus" / "mqtt, serial, rs485" / "this skill describes…".

```
# <name>

<Lead: what it is, the key convention, live triggers. 1-3 sentences.>

## <Main path — do it this way, not otherwise>

<Real commands, real names, concrete tools.>

## <Cheat sheet / typical scenarios>

<Fenced code blocks, typical snippets.>

## Pitfalls

- <typical mistake and how to avoid it>

## Documentation

- Wiki: <https://wirenboard.com/wiki/...>
- Sources: <https://github.com/wirenboard/...>
```

Choose the headings after the lead to fit the topic. The "Pitfalls" and "Documentation" sections are mandatory.

## Pitfalls

- A lead paragraph used as a "table of contents" instead of live triggers → the model won't understand when to load it.
- No lead paragraph, straight to `## Heading` → `create_skill` will return an error.
- Written for a human ("this skill will help you…") → useless, the model reads it as an instruction.
- An abstract example `dev["device/channel"]` → the model will insert it into code literally.
- Didn't specify the tools → the model will guess how to perform the task.
- A skill longer than 150 lines → cut the retelling, replace it with a link.
- Tried to update a system skill → error, system skills are protected.

## Documentation

- Wiren Board Wiki: <https://wirenboard.com/wiki/>
- Wiren Board GitHub: <https://github.com/wirenboard>
