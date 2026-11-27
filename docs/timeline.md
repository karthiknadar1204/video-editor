# Editing a private project

Open a project and use **Insert clip** to place footage, audio, a title, or a caption on its track. The bundled Earthrise rushes contain 600 frames at 30 fps. They use the Apollo 8 photograph and onboard recording credited in the [fixture notes](first-render.md).

Select a clip on the timeline to seek to its first frame and open its properties. Use **Action** to move, trim, split, or delete it. Use **Save properties** to save text, position, and volume changes together. **Undo** and **Redo** work after reopening the project.

## Frames and tracks

- Frame zero is the beginning. A clip at frame 150 with a duration of 60 occupies frames 150 through 209. Its end boundary is 210. The shortest clip is one frame.
- Timeline start places the clip in the project. Source start identifies the first frame read from the original asset. Source-relative transcript timestamps stay valid after a trim, move, or split. Media must remain within its asset. The project length is the last occupied frame plus one, up to five minutes.
- The tracks, in order, are video, speech, music, title, and caption. Clips on a single track can touch. Clips on different tracks can overlap. Titles draw above video and captions draw above titles. Speech and music mix with the video's own sound. Volume runs from zero to one. Visual positions are canvas pixels measured from the top left.
- Select a clip, choose **Add clip**, and check **Link to selected clip** to create a linked edit group. A move carries linked clips by the same distance. Trimming or splitting keeps the surviving picture, speech, and captions together. Deleting a linked clip deletes the group.
- **Ripple delete** removes the selected frame interval and closes the gap on the checked tracks and affected linked clips. A clip crossing both ends becomes two clips referencing the surviving source ranges. Music stays anchored unless included. Locking an affected track rejects the entire edit.
- At 30 fps, put a 150-frame clip at timeline frame 150 with source start 360. Split at timeline frame 210. The pieces begin at source frames 360 and 420, corresponding to seconds 12 and 14.

## Saving and synchronization

The editor posts operations, undo, and redo to `/api/projects/:id/edits`. Each command carries a unique request ID and the revision it was based on. Hono locks the owner's project row, validates the changes, and saves the timeline, history entry, and new revision in one Postgres transaction. A repeated request with identical contents returns its original receipt. A stale revision or a reused ID with different contents returns 409. Invalid editing operations return 422.

Each successful group stores forward and inverse changes. Undo reverses the newest applied group. Redo restores the earliest undone group. Making a fresh edit after undo starts a new history branch. Earlier project documents are upgraded on read and written in the current format with the next successful edit.

Open tabs listen on `/api/projects/:id/events`. Hono checks the saved revision and session every 1.5 seconds and sends the latest revision ID. Clients reload the authoritative snapshot, including after reconnecting. If another tab saves while you have a draft, **Load latest** lets you discard that draft explicitly. If a save response is lost, **Retry save** resends the same command and ID.

## Verification

Run `bun run test:timeline` for the frame rules and inverse changes. Run `bun run test:migrations` for upgrades. With Postgres and Mailpit running, `E2E_PRODUCTION=1 bun run test` runs the authenticated API and browser tests against the production build. These cover concurrent writers, retrying a committed split after losing the response, decoded preview frames across undo and redo, grouped edits, cross-tab updates, and linked ripple edits with a locked track.
