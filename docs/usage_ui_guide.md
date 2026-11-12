# Usage & UI Guide

## User management

Nobody but their owner ever chooses a user's password. **Add user** (on the *Users* page) creates the account
without one and shows a one-time link, `https://<host>/set-password.html#token=…`, for the admin to hand to the
new user, who opens it and sets their password (and is signed in). To reset a forgotten password the admin
presses **Reset password**, which makes a new link of the same kind; the user's old password and sessions keep
working until the link is used. A link works once, a newer link for the same user replaces it, and it expires
after `VG_PASSWORD_LINK_HOURS` (default 72). Only a hash of the token is stored (table `usertoken`), the token
travels in the URL fragment and in request bodies (never in a query string, so not in access logs), and the
endpoints `POST /api/users`, `POST /api/users/<id>/password-link` (admin) and
`POST /api/auth/set-password[/check]` (public, rate-limited by nginx) carry the flow. `PATCH /api/users/<id>`
no longer accepts a `password`.


## Preparing Volumes to Upload

The volume uploader accepts a **.zip of single-slice TIFF files** (one `.tif` or `.tiff` per Z position), or multiple TIFF files selected together. The backend converts the input to kiln-render's sharded binary layout using out-of-core Dask processing. Supported scalar input types are `uint8` and `uint16`.

**Note on Sorting:** Slice order is sorted naturally by filename (e.g., `slice_0001.tif`, `slice_0002.tif`). Plain numeric names (`1.tif`, `2.tif`) can sort incorrectly once the sequence reaches two digits, so always zero-pad them.

The mesh field accepts any supported mesh file (STL/OBJ/PLY/...) and stores the original for download.

## Viewer Features

*   **Export:** Saves the 3D render or a slice as PNG / JPEG / WebP / TIFF (slices at one pixel per voxel, optionally as raw voxel values).
*   **Animate:** Renders a slice sweep, a 3D turntable, or a camera path to an H.264 MP4 or a zip of images. Both run in the browser on the viewer's own GPU.
*   **Live Playback:** Animation paths can be played live and looped on screen. Shared path links (`viewer ... ?id=<volume>&play=<path>`) start automatically.
*   **Bookmarks:** Save a view (camera, render settings, slice position, thumbnail). Their camera poses can be keyframes of a path or the start of a turntable.
*   **Long-Running Displays:** While anything long-running is going on, the viewer renews its data access token in the background, so a display can run for hours.
*   **Slices at Any Angle:** The three slice panes show three perpendicular planes through the cursor. The server streams exactly the blocks needed for the requested plane angle.

## Histogram

The volume viewer draws a histogram behind the transfer-function curve. It is computed from the original full-resolution TIFF stack during conversion and stored as `histogram.json`. `VG_HISTOGRAM_THREADS` (default: up to 4) limits CPU use during conversion. 

## Branding

The name, logo, tagline, copyright, and contact details come from `branding/branding.toml`.
*   It is read on every request (no restart needed).
*   Docker mounts the folder as `/branding` (`VG_HOST_BRANDING_DIR`, default `./branding`). 
*   Replace `branding/logo.svg` with your own logo; set `logo_dark` if it needs a different version on the dark theme.

*For more details on background processing, see the [Architecture Guide](architecture.md).*