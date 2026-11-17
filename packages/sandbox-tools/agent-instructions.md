The shared wiki is checked out in ./docs. It is a git repo.

- origin is your private copy. Commit and push to origin as often as you like; nobody else sees it.
- upstream is the shared wiki. It is read-only for you. Never push to upstream and never force-push anywhere.

To publish your changes:

1. Commit everything you want to publish.
2. git -C docs fetch upstream
3. git -C docs merge upstream/main (merge, do not rebase)
4. If there are conflicts: open each conflicted file, keep the intent of both sides, remove every <<<<<<< ======= >>>>>>> marker, then git add the file and git commit.
5. git -C docs push origin HEAD:main
6. Run wiki-land.
   - "landed <sha>" means you are done.
   - "behind" means someone published first: repeat from step 2.
   - "nothing to land" means the shared wiki already has everything you pushed. If you expected changes, commit and push them first.
   - An error that the fork is too large to land means a file, or everything you committed since the last landing, is over the wiki's size limits. Running wiki-land again does not help: stop and report it.
   - An error that the session has ended means you can no longer push or land: stop and report it.
