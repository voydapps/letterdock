# Changelog

## 0.6.11 - 2026-10-12
### New
- Replied and forwarded marks: a small arrow next to the date shows mail you replied to or forwarded, also from other apps.

## 0.6.10 - 2026-10-12
### Fixed
- The unread number shows again on a Letterdock button that is pinned to the taskbar, and it is drawn at your screen's size, so it is sharp.

## 0.6.9 - 2026-10-12
### Fixed
- The unread number is now part of the Letterdock icon on the taskbar, drawn with a real font at your screen's size, so it is sharp. It also shows in Alt+Tab.

## 0.6.8 - 2026-10-11
### New
- The buttons on new-mail notifications (Mark as read, Archive, Delete) now have small icons.
- A "Show a test notification" button in Settings, Notifications. It shows a sample notification so you can see how the buttons and icons look. Its buttons do nothing to your mail.
### Fixed
- A notification no longer repeats the subject in the preview line, and long subjects are no longer cut in the middle of a word.

## 0.6.7 - 2026-10-11
### Fixed
- Mark as unread now stays on the message you are reading. Before, it was marked read again after a moment.

## 0.6.6 - 2026-10-11
### New
- Unread count on the taskbar: the Letterdock button now shows a red number with your unread mail, and the tray icon gets a red dot. You can turn each one off in Settings, Notifications.
- Hide an account from All inboxes: right-click the account, or use its settings. Its mail stays in its own folders, and it does not count in the unread badge or send notifications.

## 0.6.5 - 2026-10-11
### Fixed
- Mail that comes back from snooze now sits in one "Back from snooze" group at the top of your list. Before, it could split the "Today" group in two, so hiding "Today" hid only part of it. This also works with conversations and in the Unread view.
- If you start Letterdock with several .eml files and more than one cannot be opened, one window now lists every file with its reason. Before, only the first problem was shown.
- Reopening .eml files after Letterdock restarts its mail engine no longer lets more than 15 windows stay open.
- The shortcut list now calls Ctrl+O "Open .eml file", like the command box.

## 0.6.4 - 2026-10-11
### New
- Open .eml files: double-click a saved message, use Open with, or drag it onto Letterdock. Letterdock now appears in Windows Default apps for .eml; it never makes itself the default.
### Fixed
- No more white frame around a message when its window opens.
- Replies and forwards no longer quote the web addresses of hidden pictures. Headings also keep their capital letters.

## 0.6.2 - 2026-10-11
### New
- Delete button on the Windows notification for one new message. It moves the message to Trash. It is hidden when notifications show New mail only.

## 0.6.1 - 2026-10-11
### Fixed
- Manage quick replies, in the new email window, now opens Settings right at the Quick replies section.
- Mail that comes back from snooze now has its own group, Back from snooze, at the top of the list. It no longer pulls other emails with it.

## 0.6.0 - 2026-10-11
### New
- Unsubscribe: mailing-list mail now has an Unsubscribe button. It shows only when Letterdock can check that the sender is real. It never runs by itself. It asks you before it sends an email or opens a web page, and it remembers the lists you left.
- Snooze: hide a message until later (a toolbar button, or the H key). It comes back unread, at the top of your inbox. Snooze works on this PC only.
- Notification buttons: Mark as read and Archive on the Windows notification for one new message. You can turn them off in Settings, Notifications.
- Quick replies: save text you write often and add it from the Quick replies button when you write a message. Up to 50.
- Command box: press Ctrl+K, then type a folder or a command.
- Pin a message to the top of a folder (up to 10 per folder).
- Mute a conversation: new replies go straight to Archive without a notification.
- Tracker notice: Letterdock tells you when a message has known tracking pictures. They stay blocked, even after you allow pictures.
- A notification tells you when snoozed mail comes back. You can turn it off in Settings.
### Faster
- Search is much faster on big mailboxes. In our test with 50,000 emails it went from 1 to 57 seconds to under a tenth of a second.
- The conversation list opens much faster. In our test with 50,000 emails it took 14 ms instead of 134 ms.
- Start-up is about twice as fast. In our test with 50,000 emails Letterdock was ready in 54 ms instead of 108 ms.
- Closing Letterdock is cleaner: it no longer leaves a background timer running.

## 0.5.4 - 2026-10-10
### Changed
- New app icon, with more blue around the artwork.

## 0.5.3 - 2026-10-10
### Changed
- Letterdock no longer moves data over from the old app, Mailroom. If you still use Mailroom, add your accounts again in Letterdock.

## 0.5.0 to 0.5.2 - 2026-10-10
### New
- Sort the message list by date, sender or subject, in both directions.
- Keyboard shortcuts in the Gmail style (j and k, e, r, and more) next to the Outlook ones. See Settings, Shortcuts.
- Save a message as an .eml file, also when you are offline. A Show in folder button opens the file.
- Delete a message for good, also in Gmail.
- Click a sender to see their address and details. Long quoted text in replies is folded.
- Undo works from the message window.
### Changed
- The publisher name is now voyd. Update and website links moved to github.com/voydapps/letterdock.
### Fixed
- Send later: a message whose time has already passed is sent right away.
- Sending a saved draft no longer leaves a copy of the draft on the server, also when you are offline or restart the app.
- The address popup no longer offers to remove your own addresses from suggestions.

## 0.4.0 to 0.4.2 - 2026-10-09
### New
- Conversations: one row for each conversation, and a stacked reading pane. Turn it on in Settings, Mail.
- Send later: a split Send button, a Scheduled view, and a status bar item. Letterdock must be running to send.
- Rules: a Settings page and editor. Run a rule now, see what it did, and undo it.
- A website and a download page.
### Fixed
- The Send later menu no longer cuts off times.

## 0.3.0 - 2026-10-09
### Changed
- Mailroom is now called Letterdock. Your accounts, mail and settings move over by themselves.
### Fixed
- Folder changes you make offline are queued and sent when you are back online.
- When the server refuses to move or delete a message, Letterdock now finds out why before it undoes the change.

## 0.2.5 to 0.2.9 - 2026-10-09
### New
- Automatic updates from GitHub, and update checks that always ask for the newest version.
- A status bar at the bottom: sync, updates, outbox.
### Fixed
- The installer carries on when the old uninstaller fails (for example with Smart App Control).
