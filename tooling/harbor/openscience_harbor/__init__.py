"""OpenScience as a Harbor / Terminal-Bench installed agent.

``openscience_harbor.agent:OpenScienceAgent`` installs the pinned OpenScience
release into the task container, runs ``openscience run --format json
--auto-approve`` against the task instruction, and converts the JSON event
stream into an ATIF trajectory. ``openscience_harbor.trajectory`` holds the
dependency-free converter so it can be tested without Harbor installed.
"""
