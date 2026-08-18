# Changelog

## [1.2.0](https://github.com/theagenticguy/symspec/compare/v1.1.0...v1.2.0) (2026-08-18)


### Features

* **check:** splice the terminology tier where it cannot reach the verdict ([a74d2fe](https://github.com/theagenticguy/symspec/commit/a74d2fe16f29991152b770e9db71385e8a148a91))
* **propose-glossary:** align GUARD vocabulary, the slot that decides what gets compared ([59969d9](https://github.com/theagenticguy/symspec/commit/59969d96dd005d22bdab0393d66a16ba39f9befe))
* **propose-glossary:** offer the NOUN behind a phrase class, with its blast radius ([358d8b1](https://github.com/theagenticguy/symspec/commit/358d8b1d225449649e4f7b1c1e4dcdff0b0b49aa))
* **propose-glossary:** report every opposition, not only the ones a merge threatened ([b3b79ba](https://github.com/theagenticguy/symspec/commit/b3b79ba63a38c9d6322423c2555c521257fb64e6))
* **terminology:** the dual of the synonym bridge, at a measured floor ([c47d20c](https://github.com/theagenticguy/symspec/commit/c47d20c6a4264229bf55be265389851dd856343d))
* **terms:** a committed noun-phrase table, so one entry aligns a noun document-wide ([8a38938](https://github.com/theagenticguy/symspec/commit/8a389389c6c04db529034366174cb7a452f36c56))
* whole-document vocabulary alignment — guard slots, terms, and the terminology tier ([8fcdac7](https://github.com/theagenticguy/symspec/commit/8fcdac7cae6e8db6a43563d7734272461456e49c))


### Bug Fixes

* **formal:** a committed table must not invert a state bridge ([fbe4e67](https://github.com/theagenticguy/symspec/commit/fbe4e67610d0c5b09b7368a1f9b6acb62957f48d))
* **glossary:** a dead withhold reason, and a plan that split what it aligned ([473fbc5](https://github.com/theagenticguy/symspec/commit/473fbc5a3c6f0b79fe5967b3b015f30b4c99687c))
* **lint:** R37 stops claiming a glossary check it never ran ([a296926](https://github.com/theagenticguy/symspec/commit/a2969262938604582ee09f25358da6af9d931634))
* **publish:** gate the two code counts that had no gate, and the one that had half ([ed9e12f](https://github.com/theagenticguy/symspec/commit/ed9e12f94ba776a91067658ae8bd46dd591a57b3))

## [1.1.0](https://github.com/theagenticguy/symspec/compare/v1.0.1...v1.1.0) (2026-08-14)


### Features

* **adversarial:** restore the searcher, and close two bug classes with swept gates ([0f446e0](https://github.com/theagenticguy/symspec/commit/0f446e03db584734b93a71781914b4a8007fa1b0))
* **propose-glossary:** design the vocabulary across the whole document, not pair by pair ([a0b910e](https://github.com/theagenticguy/symspec/commit/a0b910e722f64d4f9ab45dba745e875376f3845b))


### Bug Fixes

* **engine:** the two defects the freeze kept as footnotes, red-first ([ed16eb9](https://github.com/theagenticguy/symspec/commit/ed16eb93695d660cb190f2c956a31be108d1034c))
* **repair:** every command the tool tells you to run, runs — and the README says why ([90b8c10](https://github.com/theagenticguy/symspec/commit/90b8c10f769bef1dbcbd4ee52c638ed4a46b4b57))


### Performance Improvements

* **repair-test:** read each source file once, not once per assertion ([428d155](https://github.com/theagenticguy/symspec/commit/428d15592e71527fcf01f6888861bc87faabff1a))

## [1.0.1](https://github.com/theagenticguy/symspec/compare/v1.0.0...v1.0.1) (2026-08-12)


### Bug Fixes

* **scope:** the honest-scope corpus now covers reachability, and reaches the manifest ([#8](https://github.com/theagenticguy/symspec/issues/8)) ([180ef60](https://github.com/theagenticguy/symspec/commit/180ef609146f3d8c5446bd6c0a414c655976c591))

## [1.0.0](https://github.com/theagenticguy/symspec/compare/v1.0.0-alpha.0...v1.0.0) (2026-08-12)


### ⚠ BREAKING CHANGES

* one package at the root, published via release-please + OIDC ([#3](https://github.com/theagenticguy/symspec/issues/3))

### Features

* all the things ([df0efdc](https://github.com/theagenticguy/symspec/commit/df0efdc4a6fcde8c1ca4c7cb271e0bb9d98d889c))
* blah ([a49f651](https://github.com/theagenticguy/symspec/commit/a49f6515a1856dc6311aba72f877ad44e3dfe70f))
* **cli:** add download-model command to pre-warm the semantic model cache ([1c3d3d4](https://github.com/theagenticguy/symspec/commit/1c3d3d452612c2f9c588e14eba8d69928709d5e3))
* **cli:** field-report wishlist (10 items) + `install` skill command ([1b1fb5e](https://github.com/theagenticguy/symspec/commit/1b1fb5e222fda4aa2d871c2fb1d3e40017505878))
* **embed:** replace transformers.js with pure onnxruntime-web WASM ([3c3bac4](https://github.com/theagenticguy/symspec/commit/3c3bac4b588c767adb0c7b0575134075865c9969))
* **formal:** close issue [#2](https://github.com/theagenticguy/symspec/issues/2) — verified never outruns the numeric tier; loud coverage ([fabc156](https://github.com/theagenticguy/symspec/commit/fabc1564833386f3c4831137152eee06fd32a448))
* **formal:** close the 25/30 red-team escapes — lexicon hardening, coverage-demoted verified, embeddings core ([ef40962](https://github.com/theagenticguy/symspec/commit/ef40962126798361cbf3cf61cc9524a932d5071b))
* **formal:** close the atom-matching gap — antonyms, guard-implication closure, coverage gating ([08cdc5b](https://github.com/theagenticguy/symspec/commit/08cdc5b43bece4a2966f147a9789c85c13bfe6b7))
* **formal:** close the atom-matching gap — antonyms, guard-implication closure, coverage gating ([bfeed93](https://github.com/theagenticguy/symspec/commit/bfeed934fde7441f648831524a01a15d6a6ec15a))
* **install:** bundle with tsdown + migrate to registerTool API ([baeaef1](https://github.com/theagenticguy/symspec/commit/baeaef1eda193e7f70e03f67a1ffd2ef7416a1f1))
* **install:** rename bins to symspec/symspec-mcp + ship installable tarball ([0db2f2e](https://github.com/theagenticguy/symspec/commit/0db2f2e6cdea281f157c024fd8ee97ab952cfe93))
* one package at the root, published via release-please + OIDC ([#3](https://github.com/theagenticguy/symspec/issues/3)) ([13242d9](https://github.com/theagenticguy/symspec/commit/13242d999e0787d7e04f4eecb356d95254022fbd))
* **v3.0:** deterministic numeric/arithmetic conflict tier (LIA/LRA) ([654dddb](https://github.com/theagenticguy/symspec/commit/654dddbcbec78dc144f0b53580474ebc325750bc))
* **v3.1,v3.2:** ambiguity finding family + deterministic embedding graph/DAG ([3d8ab3d](https://github.com/theagenticguy/symspec/commit/3d8ab3dd5c9467c199148277f3198ff6c81549e4))
* **v3.3:** bounded LTL→SMT temporal contradiction tier (in-process) ([e714dc5](https://github.com/theagenticguy/symspec/commit/e714dc557ff02bca901a65318d53adaef6066f85))
* **v3.4:** generative-adversarial detection harness + extractor hardening ([41899e1](https://github.com/theagenticguy/symspec/commit/41899e179951c7987fba18335e24a35e525772c9))
* **v5-agents:** AGENTS.md as a kernel projection, with a drift gate that checks BOTH halves ([0a29f28](https://github.com/theagenticguy/symspec/commit/0a29f2857501dfe7d33e49904c6b611c0692d21b))
* **v5-budget:** data.budgetHint, anchored on the run's OWN clock because a cost table did not survive measurement ([75198c8](https://github.com/theagenticguy/symspec/commit/75198c8dbab25c1db2591c398e2fa72baeef4e49))
* **v5-check:** the check op — donor pipeline through the Layer, +repair/+progress, exit contract wired ([4f9f9f8](https://github.com/theagenticguy/symspec/commit/4f9f9f855e34589a3198fb0e2767ef704a844bc7))
* **v5-core:** doc store as Layers — atomic write, donor path precedence, disjoint load codes ([58d242f](https://github.com/theagenticguy/symspec/commit/58d242f44c618ea3669067a8500dc0936908f4e6))
* **v5-core:** document format v3 — stateModel + responseKind first-class, V27 unrepresentable ([9d0cce9](https://github.com/theagenticguy/symspec/commit/9d0cce961c86a8bf1df8a01640169f36776a0eb9))
* **v5-core:** ONE op vocabulary and ONE mutation fold — repair.ops can now be real ([e41d1ba](https://github.com/theagenticguy/symspec/commit/e41d1ba445e497c16d2a2f734c90da55f761f6d8))
* **v5-craft:** the authoring-craft corpus, with every claim measured against the live detectors ([2ef4b47](https://github.com/theagenticguy/symspec/commit/2ef4b473a38a1a96ecca5e4a8755418373dcff8e))
* **v5-craft:** the craft corpus learns the state model, with a transcript that was RUN not composed ([c881853](https://github.com/theagenticguy/symspec/commit/c88185353e8554fd6e19d35501e53761077452a2))
* **v5-formal:** transplant the formal tier + SolverService Layer — 4 files edited, 35 byte-identical ([8059a68](https://github.com/theagenticguy/symspec/commit/8059a68f9e6d58a67d8ed9b1b84f548dd2ff948c))
* **v5-install:** the install op, with all three V11 defects fixed and each fix independently falsifiable ([801c8a5](https://github.com/theagenticguy/symspec/commit/801c8a588302c8f318096c0af297db79b6b30a5e))
* **v5-kernel:** --pretty/--dense/--field as envelope post-processors, exit code untouchable ([58741d6](https://github.com/theagenticguy/symspec/commit/58741d6ea155ec447443a54e676f85142d667e0e))
* **v5-kernel:** envelope + exit contract, ported as agent API not legacy ([394f2da](https://github.com/theagenticguy/symspec/commit/394f2dacc9ba1bf7289f1e8441a78a5645d3073e))
* **v5-kernel:** ERR_* catalog as 21 TaggedErrorClasses, tag IS the code ([c65f6ef](https://github.com/theagenticguy/symspec/commit/c65f6efdb833f856d24abc95ca7953b7dc395fb8))
* **v5-kernel:** ops table + CLI/manifest/help projections, three ops end-to-end ([a4c076f](https://github.com/theagenticguy/symspec/commit/a4c076fc783f576893f669b6be10035ebe6c6986))
* **v5-lint:** transplant the GTWR catalog, publish all 75 codes, and close the oracle's SECOND blind spot ([83d32b1](https://github.com/theagenticguy/symspec/commit/83d32b116b25d3628eb6edcab5eb874e06159081))
* **v5-ops:** init/import/list/show — both hex-bonk docs round-trip exactly ([aad6e5d](https://github.com/theagenticguy/symspec/commit/aad6e5d10f6fadf1c0c26e7a091e85876e2fe82d))
* **v5-ops:** the twelve mutation ops, all folding ONE vocabulary through ONE fold ([6202eb8](https://github.com/theagenticguy/symspec/commit/6202eb875c120565f9e146d68d2d8bb01438ed29))
* **v5-parse:** transplant the parse ladder + the `parse` op — ONE proposedOps name, and a DONOR BUG fixed ([ae23bc3](https://github.com/theagenticguy/symspec/commit/ae23bc3cfe897631ae6d0fd0b66a3aace82c5fa4))
* **v5-reach:** `--reachability-timeout-ms`, and the bound is the CANCELLABILITY mechanism ([03763d3](https://github.com/theagenticguy/symspec/commit/03763d31afad631d43ca5db4c2bc86eda0c88624))
* **v5-reach:** the reachability TIER in `check`, and the worked fixture found a soundness bug ([f40391a](https://github.com/theagenticguy/symspec/commit/f40391a063def4b8b9a00dfbf166be4fd53886d6))
* **v5-reach:** the Spacer Horn encoder, with polarity pinned and three real bugs found by measuring ([6fc7d57](https://github.com/theagenticguy/symspec/commit/6fc7d5709e54e931fbd85293047566e580b71d78))
* **v5-reach:** the vacuous-initial gate — an unsatisfiable Init makes every proof worthless, and the certificate check provably cannot see it ([8c23e26](https://github.com/theagenticguy/symspec/commit/8c23e26c90a94b8886664e144dd82134f8f1e062))
* **v5-repair:** repair.ops become REAL, and the round trip PROVES AC-A-1 + AC-A-2 ([4e09200](https://github.com/theagenticguy/symspec/commit/4e09200321089b5e4cd10c825dfcd04facecef14))
* **v5-semantic:** the EmbedderService Layer — propose-only, fail-closed, and both oracle sides run it ([27f93e2](https://github.com/theagenticguy/symspec/commit/27f93e2630be05ef89031e1230ab31f685be4db4))
* **v5-state:** the state model becomes authorable, with the V14/V21 hazard closed at the FRONT DOOR ([6d3f062](https://github.com/theagenticguy/symspec/commit/6d3f062d340aa7d08fa646f983393a2e84a653a8))
* **wave1:** close seven verified honesty defects ([169af27](https://github.com/theagenticguy/symspec/commit/169af27690a0fb5484ffd0d0b25debf84d09db2b))
* **wave2:** close V6 temporal unsoundness, land reproduce-ops, z3 5.0.0 ([22e0a04](https://github.com/theagenticguy/symspec/commit/22e0a043062100a9fbdbefc4d8cb945d17851d59))
* **wave2:** unify the atomizer (AC-2-7), wire the gates that gated nothing (AC-2-8a) ([4b11b8e](https://github.com/theagenticguy/symspec/commit/4b11b8ed90ca1d3463d7e24c84736669b88fe690))


### Bug Fixes

* **ci:** decide the three undecided allowBuilds — a placeholder string is not a decision ([6eaaa32](https://github.com/theagenticguy/symspec/commit/6eaaa32a944d1c67a8f43385d21189f9dbbd02a8))
* **ci:** let packageManager own the pnpm version — action-setup@v4 errors on a double pin ([03fc3e2](https://github.com/theagenticguy/symspec/commit/03fc3e2e5af14e1944f36f6eb21fdc10c06f8b7e))
* **install:** Claude Code reads .claude/skills, not .agents/skills ([fdd1f47](https://github.com/theagenticguy/symspec/commit/fdd1f47dc91d1e1c50b4d43ee75fe8eb1a4f09be))
* **v5-budget:** the hint divided by pairs IDENTIFIED, not solved — a real under-estimate the loaded suite caught ([0a5a184](https://github.com/theagenticguy/symspec/commit/0a5a1845d27556f298b740c17205568bcfdca91b))
* **v5-explain:** the code COUNT becomes a projection too — two surfaces still said 75 after G4 made it 80 ([9d2b83f](https://github.com/theagenticguy/symspec/commit/9d2b83ffdb70c42b982f935a9665b37faf708afb))
