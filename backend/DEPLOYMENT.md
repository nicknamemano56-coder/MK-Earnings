# Deployment / setup

## Local test (same PC)
```bash
set ADMIN_KEY=put-a-long-random-key-here
node server.js
```
Backend: `http://localhost:8787`

Open the upgraded User/Admin HTML files in a browser. In Admin, enter the backend URL and Admin Key under **Multi-Device Cloud**.

## Friends on the same Wi-Fi
Run the server on the PC and use the PC's LAN IP, e.g. `http://192.168.1.10:8787`, as the backend URL. Allow the port through the firewall. The server must remain running.

## Public internet
Deploy the backend to a Node 22-compatible host and use HTTPS. Set `ADMIN_KEY` as a server secret. Do not put the admin key in the User app.

For persistent data, use a host/storage option that persists the SQLite file. A temporary/ephemeral filesystem can lose the database on restart/redeploy.

## Existing data safety
The upgraded HTML does not clear existing localStorage keys. Local data stays on the device. Cloud data is separate. Do not delete the old HTML/backup files until you have verified the new backend flow.
