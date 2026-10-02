"""Construct systemd argv without treating manager operations as unit operations."""

def service_argv(action, unit=""):
    if not isinstance(action, str) or not action or action.startswith("-"):
        raise ValueError("service action is required")
    if not isinstance(unit, str) or unit.startswith("-"):
        raise ValueError("unit must be a unit name")
    if action in ("daemon-reload", "daemon-reexec"):
        if unit:
            raise ValueError("%s takes no unit" % action)
        return ["systemctl", action]
    if not unit and action != "reset-failed":
        raise ValueError("%s requires a unit" % action)
    return ["systemctl", action] + ([unit] if unit else [])
