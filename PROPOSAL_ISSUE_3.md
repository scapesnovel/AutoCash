## Proposal: Digital-thread and critical-items register schema extension

To support rocket turbopump supply chain visibility, I propose adding the following types to `schema/openchokepoint.yaml`:

### New Object Types

yaml
  Component:
    description: A part design definition.
    properties:
      part_number: { type: string, required: true }
      revision:    { type: string, required: true }
      is_critical: { type: boolean, default: false }
  SerialItem:
    description: A specific physical instance of a Component.
    properties:
      component_ref: { type: string, required: true } # links to Component id
      serial_number: { type: string, required: true }
  MaterialLot:
    description: A batch of feedstock material.
    properties:
      material_class: { type: string, required: true }
      heat_number:    { type: string, required: true }
  ProcessStep:
    description: A controlled manufacturing or inspection operation.
    properties:
      step_type: { type: enum, values: [machining, heat_treatment, cleaning, inspection, assembly] }
      outcome:   { type: enum, values: [pass, fail, pending] }


### New Link Types

yaml
  derived_from:
    from: [SerialItem]
    to: [MaterialLot]
  processed_at:
    from: [SerialItem]
    to: [ProcessStep]
  part_of:
    from: [SerialItem]
    to: [Component]


This structure allows for a traceable evidence chain from material lot through individual serialization, meeting the requirement for a shared grammar.