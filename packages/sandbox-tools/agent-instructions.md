The shared wiki is checked out in ./docs. It is a git repo.

- origin is your private copy. Commit and push to origin as often as you like; nobody else sees it.
- upstream is the shared wiki. It is read-only for you. Never push to upstream and never force-push anywhere.

To publish your changes:

1. git -C docs fetch upstream
2. git -C docs merge upstream/main (merge, do not rebase)
3. If there are conflicts: open each conflicted file, keep the intent of both sides, remove every <<<<<<< ======= >>>>>>> marker, then git add the file and git commit.
4. git -C docs push origin HEAD:main
5. Run wiki-land.
   - "landed <sha>" means you are done.
   - "behind" means someone published first: repeat from step 1.
   - An error that the fork is too large to land means a file or the history is over the wiki's size limits. Running wiki-land again does not help: stop and report it.
