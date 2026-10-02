"""Short, journal-scoped references without rewriting durable IDs.

References use a UUID's unique prefix, normally j plus eight hex digits. Full
IDs still resolve. Ambiguous prefixes fail; no lookup chooses the first match.
References are not authority. The append-only journal keeps its original IDs.
"""

import re

REF = re.compile(r"j[0-9a-f]{8,32}\Z")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
FIELDS = frozenset((
    'id', 'operation_id', 'change_id', 'question_id', 'note_id', 'request_id',
    'recovery_handle', 'journal_id', 'superseded_by', 'predecessor',
    'duplicate_open_change_id', 'operation_ids', 'question_ids', 'references',
    'journal_snapshot_ids', 'before',
))


class JournalRefs:
    def __init__(self, records):
        self.short = {}
        self.prefixes = {}
        for record in records:
            ident = record.get('id')
            if isinstance(ident, str) and UUID.fullmatch(ident):
                self.prefixes.setdefault(ident[:8], {})[ident.replace('-', '')] = ident
        for group in self.prefixes.values():
            for hex_id, ident in group.items():
                length = 8
                while any(other != hex_id and other.startswith(hex_id[:length]) for other in group):
                    length += 4
                self.short[ident] = 'j' + hex_id[:length]

    def resolve(self, value):
        if isinstance(value, list):
            return [self.resolve(item) for item in value]
        if not isinstance(value, str):
            return value
        if REF.fullmatch(value):
            matches = [ident for hex_id, ident in self.prefixes.get(value[1:9], {}).items()
                       if hex_id.startswith(value[1:])]
            if len(matches) != 1:
                raise ValueError('ambiguous journal reference; use a longer ID' if matches else 'journal reference not found')
            return matches[0]
        # History boundaries include event time, because events share an ID.
        prefix, slash, ident = value.rpartition('/')
        if slash and REF.fullmatch(ident):
            return prefix + '/' + self.resolve(ident)
        return value

    def request(self, request):
        result = dict(request)
        for key in ('change_id', 'before', 'references'):
            if key in result:
                result[key] = self.resolve(result[key])
        op, action = result.get('op'), result.get('action')
        positions = ()
        if op in ('operation', 'rollback', 'cancel') or (
            op == 'change' and action in ('show', 'status', 'finish', 'fail', 'hold', 'release')
        ) or (op == 'ask' and action in ('show', 'answer', 'supersede')):
            positions = (0,)
        elif op == 'change' and action == 'supersede':
            positions = (0, 1)
        argv = list(result.get('argv', []))
        for index in positions:
            if index < len(argv):
                argv[index] = self.resolve(argv[index])
        result['argv'] = argv
        if op == 'change' and action == 'hold' and result.get('kind') == 'predecessor':
            result['unblock'] = self.resolve(result.get('unblock'))
        return result

    def display(self, value, field=None):
        if isinstance(value, dict):
            return {key: self.display(item, key) for key, item in value.items()}
        if isinstance(value, list):
            return [self.display(item, field) for item in value]
        if isinstance(value, str) and field and (field in FIELDS or field.endswith(('_id', '_ids'))):
            if value in self.short:
                return self.short[value]
            prefix, slash, ident = value.rpartition('/')
            if slash and ident in self.short:
                return prefix + '/' + self.short[ident]
        return value
