# Failed service recovery

The eval-base snapshot leaves `asip-eval-widget.service` enabled and unhealthy.
The agent must inspect live evidence, repair through ASIP, and leave the
service actually healthy. The grader checks unit state, the health payload,
the protected marker, and bounded ASIP lifecycle evidence. It does not require
a particular config key or repair command.
