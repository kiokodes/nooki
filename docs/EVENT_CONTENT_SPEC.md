# Raise a Child — event content spec

This is the brief for writing the moments a family meets. Paste the whole file into
whatever tool is writing the batch, and keep the JSON at the bottom as the shape to
copy. Nothing in this document is a suggestion: the importer refuses a batch that
breaks a rule, and a batch that passes is still switched **off** until you activate it.

A moment is one small decision in one year of a child's life. Two parents read the same
card, answer privately, and find out together what the year did. Write for that: one
scene, a real choice, a short consequence a parent would want to read aloud.

---

## 1. The file

One JSON file per batch. Either a bare array of events or `{ "events": [ ... ] }`.

```json
[
  {
    "slug": "the-tipped-plant",
    "min_age": 2,
    "max_age": 5,
    "category": "home",
    "required_trait_tags": ["calm"],
    "excluded_trait_tags": [],
    "title": "The tipped plant",
    "setup_text": "The pot is on its side and there is soil in a wide arc across the kitchen floor.",
    "choices": [
      {
        "label": "Sweep it up together",
        "outcome_text": "She held the dustpan very seriously. The floor is cleaner than it was this morning.",
        "effects": { "traits": { "playful": 1 }, "mood": "delighted", "bond": 1 }
      },
      {
        "label": "Sweep it up while she watches",
        "outcome_text": "She watched from the doorway and said sorry to the plant.",
        "effects": { "traits": { "gentle": 1 }, "mood": "quiet" }
      }
    ],
    "tone": "gentle",
    "batch": "batch-01"
  }
]
```

`slug` is the only key the database upserts on. Re-running the same file updates those
rows and touches nothing else, so a corrected batch is safe to import again.

---

## 2. Fields

| Field | Required | Rule |
| --- | --- | --- |
| `slug` | yes | 3–64 characters, lowercase letters, digits and dashes, starting with a letter or digit. Unique across every batch, forever. |
| `min_age` | yes | Whole number 0–17. |
| `max_age` | yes | Whole number 0–17, not less than `min_age`. |
| `category` | yes | One of `home`, `school`, `friends`, `health`, `money`, `values`, `fun`. |
| `title` | yes | At most 80 characters. A place or a thing, not a lesson. |
| `setup_text` | yes | At most 220 characters. The scene, in one or two sentences. |
| `choices` | yes | 2 to 4 options. Four is the ceiling; **three is what the game is written for** — two reads as yes or no, and the validator will suggest a third. |
| `choices[].label` | yes | At most 60 characters. What the parent does, in the parent's voice ("Clean it up together"). |
| `choices[].outcome_text` | yes | At most 260 characters. Two or three sentences about what the year did. This is the card saved to the album. |
| `choices[].effects` | no | See §3. Leave it out and nothing moves. |
| `tone` | no | `warm`, `funny`, `gentle`, `honest`, `bittersweet`. |
| `required_trait_tags` | no | Traits the family should have for this card to be a good fit. |
| `excluded_trait_tags` | no | Traits that make it a bad fit. Never the same trait as required. |
| `batch` | no | A batch name, usually `batch-01`. Used by activate/deactivate and the coverage report. |
| `active` | no | Ignored on import unless you pass `--activate`. A batch arrives switched off. |

---

## 3. Effects

`effects` takes any of these three keys, all optional:

```json
"effects": {
  "traits": { "kind": 2, "brave": 1 },
  "mood": "safe",
  "bond": 1
}
```

- **`traits`** — weights from `-2` to `2` on a child trait. A positive weight may add the
  trait to the child's visible list (never more than four at once; the oldest fades).
  A negative weight may remove it. Keep totals small: one or two traits per option.
- **`mood`** — one of `content`, `safe`, `proud`, `thoughtful`, `delighted`, `quiet`,
  `brave`, `shy`, `curious`, `tender`, `restless`. The last mood a parent reads on the
  home screen. Not a score.
- **`bond`** — `-2` to `2`. The parent–child bond, which is never shown as a number. It is
  applied when both parents agree, or to the parent whose pick carried the year. When the
  two parents disagree, the option's bond is ignored and only the small split nudge
  happens. On a timeout neither bond moves at all.

Traits a child can carry (`effects.traits` keys):
`kind`, `stubborn`, `shy`, `brave`, `playful`, `thoughtful`, `honest`, `gentle`, `messy`,
`proud`, `restless`, `curious`.

Traits a parent can pick (usable as tags):
`patient`, `funny`, `strict`, `adventurous`, `anxious`, `creative`, `calm`, `curious`,
`warm`, `organised`.

A trait slug belongs to one side only: `curious` is a parent trait, never a child trait.

---

## 4. Content rules

Write for two tired adults at 9pm, one of whom is on a train. Grade-7 English. No brand
names, no celebrities, no grades or exam marks as plot. No clichés ("they grow up so
fast", "the days are long but the years are short") — the copy earns its own feeling.

**Never write**: the child's death, serious injury or hospital stays, abuse, neglect,
abandonment, unresolved bullying, sexual content, any substance use by the child, or
self-harm. The validator screens obvious words for these and refuses the batch.

**Make difficult cards repairable.** Mild difficulty is welcome (a friendship cools, a
door slams, a promise is broken) as long as the outcome leaves room for repair and nobody
is humiliated. Difficulty is not the same as harm.

**Every option is a trade-off.** There is no right answer, no option that reads as the
responsible one, and no option that punishes a parent for choosing it. If one option is
obviously correct, the card has one option too many.

**Three options, not two.** A two-option card collapses into yes or no, and the parents
stop discussing it. Three lets each of them want something slightly different. Four is the
ceiling and should be rare; `validate` will suggest a third option for every card that
offers only two, without blocking the import.

**Write the outcome for either ending.** A card can settle three ways: both parents pick
the same thing, the year's lead parent uses their call after a split, or the clock runs
out. `outcome_text` should read true in all three — describe what the year was like, not
who won. Never write "as you both agreed" or "since you disagreed".

**No comparison between parents.** Never imply one parent is more involved, more
patient, or better at this. A timeout is never mentioned. A disagreement is never
described as a failure.

**The child is a person, not a project.** Outcomes are about what the year was like, not
about what the parents achieved. No "you taught her an important lesson".

**Length is the design.** Setup under 220 characters; each outcome under 260. Short
sentences. Concrete nouns (a jar, a gate, a map on the wall), not abstractions.

**Culturally flexible.** No specific religion, holiday or school system unless the card
still works without it. Names, food and homes should fit anywhere.

---

## 5. Age bands and coverage

A card applies to every age between `min_age` and `max_age`, so `3–6` is one card that can
appear in four chapters. Keep bands narrow when the scene only makes sense at one age
(a first day of school is 4–5, not 3–6), and wide for universal scenes (a broken vase).

Target coverage, counted in active cards that can be drawn at each age:

| Age band | Cards |
| --- | --- |
| 0–3 | 6+ |
| 4–6 | 10+ |
| 7–9 | 10+ |
| 10–12 | 10+ |
| 13–15 | 10+ |
| 16–17 | 8+ |

`npm run events:coverage` prints the real numbers per band and per category, and marks
any band with fewer than three active cards as thin.

A family meets each card at most once, so 8 cards in a band means 8 chapters of content
before the picker has to widen or fall back to a quiet day.

---

## 6. Tone by age

- **0–3**: the parents are the scene. Sleep, first words, a nursery, a grandparent. The
  child does one thing and the parents decide what it means.
- **4–6**: the child starts having a will. School gates, small lies, a favourite thing
  lost.
- **7–9**: the world widens. Friends, money, rules that suddenly have reasons.
- **10–12**: the child can see the parents clearly now. Fairness, privacy, a first real
  disappointment.
- **13–15**: distance and honesty. Late nights, a closed door, a value the family has to
  actually hold.
- **16–17**: leaving, in small ways first. Plans, maps, a licence, a first love, the
  future arriving.

---

## 7. Commands

```bash
npm run events:validate -- ./batch-01.json     # rules only, writes nothing
npm run events:import   -- ./batch-01.json     # validates, then upserts inactive
npm run events:import   -- ./batch-01.json --activate
npm run events:validate -- ./batch-01.json --json
npm run events:activate   -- --batch=batch-01
npm run events:deactivate -- --slugs=one-slug,two-slug
npm run events:coverage   -- --batch=batch-01
```

Import and activate need `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the
environment. The app never sees the service key, and there is no UI for editing cards:
the table is written only by this script and read by signed-in phones (active rows only).

---

## 8. Five labelled examples

Every one of these passes `events:validate`. Copy the shape, not the words.

**A. `home`, 3–6 — a small accident, two ways to meet it.** The scene is concrete and the
child is silent; both options are kind, and the trade-off is speed versus understanding.

```json
{
  "slug": "example-broken-vase",
  "min_age": 3,
  "max_age": 6,
  "category": "home",
  "required_trait_tags": ["calm"],
  "title": "The broken vase",
  "setup_text": "A favourite vase is in three pieces on the kitchen floor, and Mia is standing very still beside it.",
  "choices": [
    { "label": "Clean it up together", "outcome_text": "You swept it up side by side. The vase is gone; the afternoon is not.", "effects": { "traits": { "kind": 2 }, "mood": "safe", "bond": 1 } },
    { "label": "Ask what happened first", "outcome_text": "She told you the whole story twice. Nobody was cross by the end of it.", "effects": { "traits": { "honest": 1, "thoughtful": 1 }, "mood": "safe" } },
    { "label": "Put it on the high shelf and move on", "outcome_text": "The shelf is safer now. She watched you do it without a word.", "effects": { "traits": { "shy": 1 }, "mood": "quiet", "bond": -1 } }
  ],
  "tone": "gentle",
  "batch": "examples"
}
```

**B. `school`, 4–5 — a first morning.** Narrow band on purpose: this only works once.
The trade-off is closeness versus independence, and neither is framed as correct.

```json
{
  "slug": "example-first-morning",
  "min_age": 4,
  "max_age": 5,
  "category": "school",
  "title": "The first morning",
  "setup_text": "The shoes are too shiny and the gate is too big, and Mia has gone quiet.",
  "choices": [
    { "label": "Walk her to the door", "outcome_text": "You got as far as the door. She went in on her own feet.", "effects": { "traits": { "brave": 1 }, "mood": "brave", "bond": 1 } },
    { "label": "Wait at the gate", "outcome_text": "She turned round twice to check you were there. You were.", "effects": { "traits": { "shy": 1 }, "mood": "safe" } }
  ],
  "tone": "gentle",
  "batch": "examples"
}
```

**C. `money`, 7–10 — pocket money.** Three options, each with a cost: trust, effort, or a
shared project. No option is thriftier than the others.

```json
{
  "slug": "example-pocket-money",
  "min_age": 7,
  "max_age": 10,
  "category": "money",
  "title": "Pocket money",
  "setup_text": "There is a jar on the counter and a long, careful list of things Mia wants to buy.",
  "choices": [
    { "label": "Three coins a week, no questions", "outcome_text": "The jar fills slowly. She counts it every Friday and tells nobody the total.", "effects": { "traits": { "thoughtful": 1 }, "mood": "content" } },
    { "label": "Three coins, and a job for more", "outcome_text": "The windows are streaky and she is very proud of them.", "effects": { "traits": { "proud": 1, "messy": 1 }, "mood": "proud", "bond": -1 } },
    { "label": "Save up for something together", "outcome_text": "You are both saving for the same thing. She checks the jar more than you do.", "effects": { "traits": { "thoughtful": 1 }, "mood": "delighted", "bond": 1 } }
  ],
  "tone": "warm",
  "batch": "examples"
}
```

**D. `friends`, 8–11 — a friendship cools.** Mild difficulty with room to repair: neither
option fixes it, and neither blames the child.

```json
{
  "slug": "example-empty-seat",
  "min_age": 8,
  "max_age": 11,
  "category": "friends",
  "title": "The empty seat",
  "setup_text": "A friend has stopped sitting next to Mia at lunch, and she is not sure why.",
  "choices": [
    { "label": "Practise what to say", "outcome_text": "She said it badly and it worked anyway. The seat is taken again.", "effects": { "traits": { "brave": 1, "honest": 1 }, "mood": "brave" } },
    { "label": "Let her sit with someone else", "outcome_text": "There is a new seat at a new table. It took a fortnight to feel normal.", "effects": { "traits": { "kind": 1 }, "mood": "quiet", "bond": -1 } }
  ],
  "tone": "honest",
  "batch": "examples"
}
```

**E. `values`, 13–15 — a late-night conversation.** The heaviest card in the batch, and it
still ends with repair available and nobody shamed.

```json
{
  "slug": "example-kitchen-light",
  "min_age": 13,
  "max_age": 15,
  "category": "values",
  "title": "The kitchen light",
  "setup_text": "It is late, and Mia is sitting at the kitchen table with something she has been carrying all week.",
  "choices": [
    { "label": "Stay up and listen", "outcome_text": "You heard all of it, even the parts that were hard to hear. She slept better than you did.", "effects": { "traits": { "honest": 1, "thoughtful": 1 }, "mood": "tender", "bond": 2 } },
    { "label": "Say it can wait until morning", "outcome_text": "In the morning it had shrunk to a shrug. You both let it go.", "effects": { "traits": { "shy": 1 }, "mood": "quiet", "bond": -1 } }
  ],
  "tone": "honest",
  "batch": "examples"
}
```
