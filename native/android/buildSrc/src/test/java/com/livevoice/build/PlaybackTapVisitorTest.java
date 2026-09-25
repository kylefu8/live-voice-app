package com.livevoice.build;

import org.junit.Test;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;
import static org.junit.Assert.*;

public class PlaybackTapVisitorTest {
    @Test
    public void refusesMissingOrAmbiguousPlaybackBoundaryAfterUpstreamChanges() {
        for (int calls : new int[]{0, 2}) {
            PlaybackTapVisitor visitor = new PlaybackTapVisitor(new ClassVisitor(Opcodes.ASM9) {});
            MethodVisitor method = visitor.visitMethod(Opcodes.ACC_PUBLIC, "run", "()V", null, null);
            for (int i = 0; i < calls; i++) method.visitMethodInsn(Opcodes.INVOKEVIRTUAL,
                    "android/media/AudioTrack", "write", "(Ljava/nio/ByteBuffer;II)I", false);
            try {
                visitor.visitEnd();
                fail("Changed WebRTC boundary must require an integration review");
            } catch (IllegalStateException expected) {
                assertTrue(expected.getMessage().contains("boundary changed"));
            }
        }
    }

    @Test
    public void preservesTheAudioCallStackAndLeavesOtherMethodsAlone() {
        final int[] wrapped = {0};
        final int[] original = {0};
        ClassVisitor output = new ClassVisitor(Opcodes.ASM9) {
            @Override public MethodVisitor visitMethod(int access, String name, String desc, String signature, String[] exceptions) {
                return new MethodVisitor(Opcodes.ASM9) {
                    @Override public void visitMethodInsn(int opcode, String owner, String method, String descriptor, boolean isInterface) {
                        if (owner.equals("com/livevoiceapp/recording/RecordingAudioTap")) {
                            assertEquals(Opcodes.INVOKESTATIC, opcode);
                            assertEquals("(Landroid/media/AudioTrack;Ljava/nio/ByteBuffer;II)I", descriptor);
                            wrapped[0]++;
                        } else { original[0]++; }
                    }
                };
            }
        };
        PlaybackTapVisitor visitor = new PlaybackTapVisitor(output);
        for (String methodName : new String[]{"run", "unrelated"}) {
            visitor.visitMethod(Opcodes.ACC_PUBLIC, methodName, "()V", null, null)
                    .visitMethodInsn(Opcodes.INVOKEVIRTUAL, "android/media/AudioTrack", "write",
                            "(Ljava/nio/ByteBuffer;II)I", false);
        }
        visitor.visitEnd();
        assertEquals(1, wrapped[0]);
        assertEquals(1, original[0]);
    }
}
