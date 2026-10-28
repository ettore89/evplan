# How to run EV Production Planner on your laptop

*A step-by-step guide for people with no technical background.*

You don't need to know GitHub or programming. In short:

1. Install one free program (**Docker Desktop**). It runs the app and its database inside your laptop.
2. Download the project files.
3. Type **one** command.
4. Open the app in your web browser.

---

## Step 1 – Install Docker Desktop (one time only)

1. Go to **https://www.docker.com/products/docker-desktop/** and download the version for your computer (Windows, or Mac with Apple or Intel chip).
2. Run the installer and accept the default options. Windows may ask you to restart the computer; let it.
3. Open **Docker Desktop** from the Start menu (Windows) or the Applications folder (Mac). Wait until it shows that it is **running**, usually a green indicator in the bottom-left corner.

> **Company laptop?** You may need administrator rights, so ask IT if the installation is blocked. Large companies need a paid Docker Desktop licence for business use. Ask IT whether one is available.

Docker Desktop must be **open and running** every time you want to use the app.

## Step 2 – Download the project (one time only)

GitHub is simply the website where the project's files are stored. You only need to download them.

1. Go to **https://github.com/ettore89/evplan** and sign in.
2. Click the green **`<> Code`** button, then **Download ZIP**.
3. Open your **Downloads** folder and find `evplan-main.zip`.
   - **Windows:** right-click it → **Extract All…** → **Extract**.
   - **Mac:** double-click it.
4. You now have a folder called **`evplan-main`**. You can move it somewhere convenient, such as *Documents*.

## Step 3 – Open a command window inside that folder

A command window is a plain text window where you type an instruction and press Enter.

- **Windows:**
  1. Open the `evplan-main` folder in File Explorer. You should see files such as `README.md` and `docker-compose.yml`.
  2. Click the **address bar** at the top of the window (where the folder path is shown).
  3. Type `cmd` and press **Enter**.
  4. A black window opens, already "inside" the folder.
- **Mac:**
  1. Open Finder and right-click (or Ctrl-click) the `evplan-main` folder.
  2. Choose **Services → New Terminal at Folder**.
  3. If that option is missing: open the **Terminal** app, type `cd ` (with a space after it), drag the `evplan-main` folder into the Terminal window, and press **Enter**.

## Step 4 – Start the app

1. First check that Docker answers. Type this and press **Enter**:

   ```
   docker compose version
   ```

   You should see a version number. If you see *"not recognized"* or *"cannot connect"*, Docker Desktop is not running: open it, wait a minute, and try again.

2. Now start the app. Type this and press **Enter**:

   ```
   docker compose up --build
   ```

- **The first time takes about 3–10 minutes.** A lot of text will scroll past. That is normal.
- The app is ready when you see this line:
  `EV production planner listening on http://localhost:4000`
- **Leave this window open** while you use the app. Closing it stops the app.

## Step 5 – Use the app

1. Open your web browser (Chrome, Edge, Safari…) and go to: **http://localhost:4000**

   This address works only on your own laptop. Nobody else can see it.

2. Log in with one of the demo users. The password is always **`demo`**.

| Username | Role |
|---|---|
| `program` | Management / Program (can do everything). **Start with this one.** |
| `commercial` | Commercial |
| `mfg` | Manufacturing |
| `test` | Testing |
| `rnd` | R&D |
| `logistics` | Logistics |
| `service` | Service |

**Want to see two people working at once?** Open a second browser, or a private/incognito window, and log in as a different user. Changes made by one appear for the other straight away.

---

## Everyday use

| What you want | What to do |
|---|---|
| Stop the app | Click inside the command window and press **Ctrl + C**. Or press **Stop** next to "evplan" in Docker Desktop. |
| Start it again another day | Open Docker Desktop, then repeat **Step 3** and **Step 4**. It starts in under a minute after the first time, and your data is kept. |
| Wipe everything and start again with fresh demo data | In the command window type `docker compose down -v`, press **Enter**, then run `docker compose up --build` again. |

## Optional – switch on the full AI assistant

The **AI Assistant** page works without any setup in a limited mode that understands the example questions. For free-form questions it needs an Anthropic API key:

1. In the `evplan-main` folder, create a plain text file named exactly **`.env`** (with Notepad on Windows, or TextEdit set to *Format → Make Plain Text* on Mac).
2. Put this one line in it, replacing the text after `=` with your key, and save:

   ```
   ANTHROPIC_API_KEY=your-key-here
   ```

3. Stop the app (**Ctrl + C**) and start it again (`docker compose up --build`).

## If something goes wrong

| What you see | What to do |
|---|---|
| `docker` is "not recognized" / "command not found" | Docker Desktop isn't installed or isn't running. Open it, wait until it is running, then try again. |
| "cannot connect to the Docker daemon" | Same as above: Docker Desktop is not running yet. |
| "no configuration file provided" | The command window is not inside the `evplan-main` folder. Redo **Step 3**. |
| "port is already allocated" / "address already in use" | Another program is using the same address. Restart the laptop and try again. |
| The browser says the page can't be reached | The app is still starting. Wait for the `listening on http://localhost:4000` line. |
| Any other error | Copy the last 20 or so lines of text from the command window and send them to the person who supports you with the app. |
