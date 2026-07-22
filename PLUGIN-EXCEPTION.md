# Segment Plugin Exception

Additional permission under GNU Affero General Public License version 3,
section 7.

Segment is licensed under the GNU Affero General Public License, version 3 only
(see [LICENSE](LICENSE)). This document grants one additional permission on top
of that license. It does not replace, weaken or modify any other term of the
AGPL as it applies to Segment itself.

## Definitions

**"Segment"** means this program and any modified version of it.

**"Plugin API"** means the interfaces that the Segment documentation explicitly
designates as the Segment Plugin API, together with the wire formats and data
structures those interfaces accept and return.

**"Segment Plugin"** means an independent module that interacts with Segment
solely through the Plugin API. A module is not independent, and is therefore not
a Segment Plugin, if it is derived from or based on Segment source code, or if
it reproduces, adapts or embeds any part of Segment other than the Plugin API
definitions themselves.

## Grant of additional permission

As a special exception, the copyright holders of Segment give you permission to
combine Segment with Segment Plugins, and to convey the resulting combination,
regardless of the license terms of those Segment Plugins.

You may convey a Segment Plugin under terms of your choice, including
proprietary terms and terms that charge a fee, and you are not required to
release its source code. This applies whether the Segment Plugin is conveyed
separately or together with Segment.

## Network use

For the avoidance of doubt, this permission applies equally to section 13 of the
GNU Affero General Public License. Making Segment available to users over a
network while Segment Plugins are installed does not, by itself, require you to
offer the Corresponding Source of those Segment Plugins.

Section 13 continues to apply in full to Segment itself. If you run a modified
version of Segment and users interact with it remotely over a network, you must
still offer them the Corresponding Source of your modified Segment.

## What this exception does not cover

This exception is limited to Segment Plugins as defined above. In particular it
does not permit:

- conveying a modified version of Segment under terms other than the AGPL;
- avoiding the AGPL by moving Segment functionality into a module and calling it
  a plugin, where that module is derived from or based on Segment source code;
- combining Segment with a module through interfaces other than the Plugin API
  and treating that module as a Segment Plugin.

Each Segment Plugin remains subject to the terms of its own license, and you
must satisfy those terms independently of this exception.

Themes, sticker packs, icon sets and comparable assets that consist only of data
consumed by Segment are not derivative works of Segment and do not require this
exception. They may be licensed and sold freely.

This exception grants no rights in the Segment name, logo or visual identity,
which are reserved separately from the software license.

## Extending or removing this exception

If you modify Segment, you may extend this exception to your version, but you
are not obligated to do so. If you do not wish to extend it, delete this
statement and the reference to it in [LICENSE](LICENSE) from your version.

## Note on status

At the time this exception was added, the Plugin API had not yet been published.
The exception is written to apply automatically once interfaces are designated
as the Plugin API in the project documentation. Until then, no interface
qualifies and the exception grants nothing in practice.

The exception is granted in advance deliberately: it can be granted now by the
sole copyright holder, and becomes materially harder to grant once the project
has accepted contributions from others.
