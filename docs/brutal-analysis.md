# Brutal product analysis — skill-audit

*Framing: this is judged as an open-source tool meant to be genuinely useful and pull real users/stars — NOT as a venture-scale product. The metric is "would power users install it, keep it, and star it," not TAM or ARR. Written 2026-08-01, brutal but grounded.*

## Verdict up front

**7.0 / 10 as an OSS tool worth shipping — conditional on one reposition.** The floor is high because the author uses it and it found real problems in his own directory; the ceiling is capped by a crowded field and a differentiator with lower search-intent than the crowded part. Ship it, but not as "a skill security scanner." Ship it as "know what your skills are doing," with security as one of three lenses.

## What's genuinely strong

**You dogfood it, and it works on you.** The single most predictive signal for an OSS tool people love is that the author reaches for it themselves. This found live issues in your own 75-skill directory — duplicate descriptions colliding on dispatch, 70/75 skills never firing, real `--dangerously-skip-permissions` and `curl|bash` in a vendored repo. That's not a demo; that's use. Most tools that pull stars started exactly here.

**The usage-analytics-from-transcripts is the actual differentiator, and it's not a prompt.** Every competitor scans skill *files*. None reads your local session history to tell you which skills fire, which never have, and which get interrupted mid-invocation. That fusion — security + collision detection + real usage — is un-colonized, personal to each machine, and genuinely can't be reproduced by asking Claude to "check my skills." This is the closest thing to a moat a 16-line-philosophy tool can have.

**Agent-first is a real UX insight the field lacks.** The competitors are CLIs a human has to remember to run. The companion skill + `--agent` mode (1.8k tokens vs 22k) means the tool fires the way people actually work now — "audit my skills" to the agent. The pre-scan-before-reading security semantic is genuinely thoughtful.

**The ergonomics are right for adoption.** Zero runtime dependencies, offline, fast (sub-second on 75 skills + 42MB of transcripts), `npx`-native, auditable in one sitting. For a security-adjacent tool, "you can read the whole thing yourself" is a feature, not a footnote.

**The honesty builds the exact currency this category runs on.** Severity/confidence as separate axes, "a clean scan is not a guarantee," disclosing that SkillCloak defeats ~96% of all static scanners including this one. Security OSS lives on trust; overclaiming is how you lose it. This posture is right.

## What's brutal

**The field is colonized, and you found that out after building.** NVIDIA SkillSpector, Cisco AI Defense, Snyk Skill Inspector, plus clawscan/skillcop/ai-skill-scanner. This is your recurring pattern — chox-track and ai-token-roi-platform both died to a positioning discovery that arrived post-build. The difference this time: the discovery arrived *before ship*, and the fusion angle survives it. But be honest that "the skill security scanner" as a headline is taken five times over.

**Your differentiator has lower search-intent than the crowded part.** People search "skill security scanner" because malware is scary. Nobody searches "which of my skills never fire." The thing that makes you distinct (hygiene + usage) is the thing with weaker pull; the thing with strong pull (security) is where you're the seventh entrant and the smallest-resourced. That inversion is the core tension of the whole product, and no amount of engineering fixes it — only positioning and a good launch narrative do.

**The pain scales with skill count, and the median user isn't near your 75.** You have 75 skills largely because gstack vendors ~53. A typical Claude Code user has under ten and feels none of this. Your real audience is power users with bloated skill dirs plus the security-curious — exactly the star-giving demographic, but a genuinely smaller pool than "all Claude Code users." Right-size the expectation: this is a useful niche tool, not a blow-up.

**Security implies a maintenance treadmill you probably won't run.** Pattern scanners rot; attackers adapt (that's literally what SkillCloak is). A credible security tool needs its threat patterns kept current, and you are one person who will get a Dayforce internship and move on. The hygiene/usage half doesn't rot — collisions and token cost are evergreen. This is another reason to make security the supporting lens, not the load-bearing promise: the load-bearing promise should be the part that stays true without you feeding it.

**Security tools carry reputational tail risk.** Ship "catches malware," someone gets popped by something you missed, and the failure is memorable in a way a hygiene tool's miss never is. The honest framing mitigates this only for people who read it. De-emphasizing the security headline is risk management, not just positioning.

**Name is generic in a crowded namespace.** `skill-audit` will be lost among skillscan, clawscan, skillcop, skillspector. It's fine for the hygiene framing (it reads like "lint for skills") but it does no work to make someone remember you. The skillet pairing is your best memorability lever — lean on "skillet + skill-audit, the fixer and the auditor" harder than on the name alone.

## The reposition that unlocks the 7

Stop competing where you're the seventh and smallest. Lead with the sentence only you can say: **"Know what your skills actually are — what they cost you every session, which ones never fire, which ones collide, and whether any of them are doing something they shouldn't."** Security becomes the third bullet, not the banner. This:

- plays to your real, un-colonized strength (usage analytics),
- sidesteps the maintenance treadmill and the tail risk,
- is still honestly a security tool for anyone who wants that lens,
- and matches your own origin story — you built this because dispatch was misfiring, not because you got hacked.

## Score by dimension

- **Real pain (for you):** 9 — documented, personal, recurring.
- **Real pain (for the median user):** 5 — scales with skill count; most aren't there yet.
- **Differentiation:** 7 — the fusion is genuinely novel; the security half is not.
- **Distribution / discoverability:** 5 — crowded namespace, strong-pull angle is the saturated one.
- **Defensibility (won't be a prompt / won't be Sherlocked):** 7 — transcript analytics is sticky; skills are cross-vendor so Anthropic scans its marketplace, not your local dir.
- **Maintenance realism:** 6 — hygiene half is evergreen; security half rots if unfed.
- **Fit to your stated goal (useful OSS, stars as signal, built for yourself):** 8 — this is squarely the thing you said you wanted, more defensible than CWC.

**Composite 7.0.** Not a venture business — correctly, you never wanted one. A genuinely useful tool with an honest niche ceiling and a high floor, worth shipping if you reposition and accept the ceiling.

## The one thing to do before shipping

A cold-session adversarial review. This whole build happened in one long conversation where I made most of the engineering calls; a fresh agent with no attachment should try to break the detection engine and pressure-test whether the *product* (not the code) is worth it. The code is good. Whether to ship, and how to frame it, is the open question — and it's yours, not mine.
